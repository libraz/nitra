//! Inpainting one small round region of a photograph.
//!
//! This is the only hand-written WebAssembly in the project, and the reason is
//! the shape of the work rather than a preference. Every other heavy step is a
//! fragment shader because every other heavy step reads a fixed neighbourhood
//! and writes one pixel. Filling a hole is not that: each pixel's answer is a
//! patch copied from somewhere else in the same image, the somewhere else is
//! found by iterated search, and the search reads memory in an order nothing
//! knows in advance. That is the one thing a GPU is bad at and a CPU is fine at,
//! and it stays affordable because the region is a blemish rather than a frame.
//!
//! The method is PatchMatch: a nearest-neighbour field over the hole, refined by
//! propagating good matches to neighbours and then trying random offsets, with
//! the fill re-voted from the field between passes. What it buys over averaging
//! the surroundings is the whole point of the stage — an average leaves a smooth
//! patch with no pores in it, which is the plastic skin the rest of the pipeline
//! is built to avoid. Copied patches bring real skin texture with them.
//!
//! The pixels arrive exactly as the photograph was decoded, eight bits per
//! channel and still encoded, and they leave the same way. Nothing here converts
//! to a working space: patches are matched on the values the file holds, which is
//! both what every implementation of this does and the reason the result can be
//! written straight back into the plate the renderer samples.
//!
//! The interface is a pointer and a length. There is no binding layer because
//! there is nothing to bind: no strings, no structures, no callbacks — one buffer
//! in, the same buffer out, which is what the raw module ABI already expresses.

/// Half-width of the patches that are matched and copied.
///
/// Seven across. Wider carries more structure and is slower by its area; this is
/// enough to hold the direction of a pore pattern, which is what has to survive.
const PATCH: i32 = 3;

/// Search-and-vote passes over the hole.
///
/// The field is most of the way to its answer after two, and the later passes
/// are what stop a copied patch from disagreeing with its neighbours.
const PASSES: usize = 5;

/// Random offsets tried per pixel per pass, at halving distances.
const ATTEMPTS: u32 = 8;

/// Rays cast outwards to seed the fill before any patch is matched.
const SEED_RAYS: usize = 8;

/// Reserve a buffer the host can write into.
///
/// The host owns the contents and the lifetime; this only asks the allocator for
/// room. Returned as a bare pointer because that is the only thing the module
/// boundary can carry.
#[no_mangle]
pub extern "C" fn allocate(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let ptr = buffer.as_mut_ptr();
    core::mem::forget(buffer);
    ptr
}

/// Hand a buffer from [`allocate`] back.
///
/// # Safety
/// `ptr` and `len` must be exactly what [`allocate`] returned and was asked for.
#[no_mangle]
pub unsafe extern "C" fn release(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Fill a round hole in an RGBA region, in place.
///
/// Every distance is in pixels of the region, which the host has already cut out
/// of the photograph — the recipe holds the spot as a fraction of the image and
/// the conversion happens once, on the host, where the image size is known.
///
/// Returns the number of pixels the fill reached, so the host can tell a spot
/// that did something from one placed where there was nothing to do.
///
/// # Safety
/// `ptr` must point to `width * height * 4` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn heal(
    ptr: *mut u8,
    width: u32,
    height: u32,
    cx: f32,
    cy: f32,
    radius: f32,
    feather: f32,
) -> u32 {
    let len = (width as usize) * (height as usize) * 4;
    let pixels = core::slice::from_raw_parts_mut(ptr, len);
    inpaint(pixels, width as i32, height as i32, cx, cy, radius, feather)
}

/// Where a pixel sits relative to the hole: inside it, its soft edge, or clear.
struct Hole {
    /// True for the pixels the fill replaces outright.
    inside: Vec<bool>,
    /// How much of the fill each pixel takes, one inside and nought clear.
    coverage: Vec<f32>,
    /// Indices of the pixels being filled, in scan order.
    order: Vec<usize>,
}

fn hole_of(width: i32, height: i32, cx: f32, cy: f32, radius: f32, feather: f32) -> Hole {
    let count = (width * height) as usize;
    let mut inside = vec![false; count];
    let mut coverage = vec![0.0f32; count];
    let mut order = Vec::new();
    let outer = radius + feather.max(0.0);
    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let distance = (dx * dx + dy * dy).sqrt();
            let index = (y * width + x) as usize;
            if distance <= radius {
                inside[index] = true;
                coverage[index] = 1.0;
                order.push(index);
            } else if distance < outer {
                // Smooth rather than linear: a crease in the blend is visible on
                // skin as a ring, which is a worse mark than the one being
                // removed.
                let t = (outer - distance) / (outer - radius);
                coverage[index] = t * t * (3.0 - 2.0 * t);
            }
        }
    }
    Hole {
        inside,
        coverage,
        order,
    }
}

/// Which patch centres the search is allowed to copy from.
///
/// Two conditions, and both matter. A patch that runs off the edge of the region
/// has nothing to match against out there, and a patch overlapping the hole
/// would let the hole copy itself — which is how an inpaint smears instead of
/// filling.
///
/// Decided once for the whole region rather than per candidate. The test costs a
/// forty-nine tap scan, and the search asks it tens of thousands of times.
fn allowed_centres(hole: &Hole, width: i32, height: i32) -> Vec<bool> {
    let count = (width * height) as usize;
    let mut allowed = vec![false; count];
    for y in PATCH..height - PATCH {
        for x in PATCH..width - PATCH {
            let mut clear = true;
            'patch: for dy in -PATCH..=PATCH {
                for dx in -PATCH..=PATCH {
                    if hole.inside[((y + dy) * width + x + dx) as usize] {
                        clear = false;
                        break 'patch;
                    }
                }
            }
            allowed[(y * width + x) as usize] = clear;
        }
    }
    allowed
}

fn usable(allowed: &[bool], width: i32, height: i32, x: i32, y: i32) -> bool {
    if x < 0 || y < 0 || x >= width || y >= height {
        return false;
    }
    allowed[(y * width + x) as usize]
}

/// Seed the hole by reaching outwards for the nearest pixel the photo still has.
///
/// Not the answer — it has no texture in it at all — but the patch search needs
/// something inside the hole to compare a candidate against, and a hole full of
/// whatever was there before would have it matching the blemish. Rays rather
/// than a blur because the cost is bounded by the hole's radius rather than by
/// its area, and because reaching along a direction keeps a shadow's gradient
/// pointing the way it was going.
fn seed(work: &mut [f32], hole: &Hole, width: i32, height: i32) {
    let reach = width.max(height);
    for &index in &hole.order {
        let x = (index as i32) % width;
        let y = (index as i32) / width;
        let mut total = [0.0f32; 3];
        let mut weight = 0.0f32;
        for ray in 0..SEED_RAYS {
            let angle = (ray as f32) * core::f32::consts::TAU / (SEED_RAYS as f32);
            let (sin, cos) = angle.sin_cos();
            for step in 1..=reach {
                let sx = (x as f32 + cos * step as f32).round() as i32;
                let sy = (y as f32 + sin * step as f32).round() as i32;
                if sx < 0 || sy < 0 || sx >= width || sy >= height {
                    break;
                }
                let at = (sy * width + sx) as usize;
                if hole.inside[at] {
                    continue;
                }
                let w = 1.0 / (step as f32);
                for channel in 0..3 {
                    total[channel] += work[at * 4 + channel] * w;
                }
                weight += w;
                break;
            }
        }
        if weight <= 0.0 {
            continue;
        }
        for channel in 0..3 {
            work[index * 4 + channel] = total[channel] / weight;
        }
    }
}

/// Sum of squared differences between the patch around a hole pixel and the one
/// around a candidate, over the channels that carry the picture.
///
/// Taps that fall outside the region are skipped rather than clamped: a clamped
/// tap compares a candidate against a repeat of the edge, which makes every
/// candidate near the edge look better than it is.
fn cost(
    work: &[f32],
    (width, height): (i32, i32),
    (tx, ty): (i32, i32),
    (sx, sy): (i32, i32),
    ceiling: f32,
) -> f32 {
    let mut total = 0.0f32;
    for dy in -PATCH..=PATCH {
        let ay = ty + dy;
        let by = sy + dy;
        if ay < 0 || by < 0 || ay >= height || by >= height {
            continue;
        }
        for dx in -PATCH..=PATCH {
            let ax = tx + dx;
            let bx = sx + dx;
            if ax < 0 || bx < 0 || ax >= width || bx >= width {
                continue;
            }
            let a = ((ay * width + ax) * 4) as usize;
            let b = ((by * width + bx) * 4) as usize;
            for channel in 0..3 {
                let d = work[a + channel] - work[b + channel];
                total += d * d;
            }
        }
        if total >= ceiling {
            return total;
        }
    }
    total
}

/// A small deterministic generator.
///
/// Deterministic on purpose: the same spot on the same photograph has to come
/// out the same way twice, or an export would not match the preview it was
/// approved from.
struct Noise(u32);

impl Noise {
    fn next(&mut self) -> u32 {
        // xorshift32
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }

    fn below(&mut self, bound: i32) -> i32 {
        if bound <= 0 {
            return 0;
        }
        (self.next() % (bound as u32)) as i32
    }
}

fn inpaint(
    pixels: &mut [u8],
    width: i32,
    height: i32,
    cx: f32,
    cy: f32,
    radius: f32,
    feather: f32,
) -> u32 {
    if width <= 0 || height <= 0 || radius <= 0.0 {
        return 0;
    }
    let count = (width * height) as usize;
    if pixels.len() < count * 4 {
        return 0;
    }

    let hole = hole_of(width, height, cx, cy, radius, feather);
    if hole.order.is_empty() {
        return 0;
    }

    let allowed = allowed_centres(&hole, width, height);
    let mut sources = Vec::new();
    for y in 0..height {
        for x in 0..width {
            if allowed[(y * width + x) as usize] {
                sources.push((x, y));
            }
        }
    }
    if sources.is_empty() {
        // The hole fills the region, or comes close enough that no patch sits
        // clear of it. Nothing can be copied from a photograph that is not
        // there, and inventing something is the one answer worth refusing.
        return 0;
    }

    let mut work: Vec<f32> = pixels.iter().map(|&v| v as f32).collect();
    seed(&mut work, &hole, width, height);

    // The field, one source pixel per hole pixel, and the cost it was accepted
    // at. Indexed by position in `hole.order` so the passes below can walk it
    // forwards and backwards.
    let mut noise = Noise(0x9e3779b9);
    let mut field: Vec<(i32, i32)> = Vec::with_capacity(hole.order.len());
    for _ in &hole.order {
        field.push(sources[noise.below(sources.len() as i32) as usize]);
    }

    let mut slot = vec![usize::MAX; count];
    for (at, &index) in hole.order.iter().enumerate() {
        slot[index] = at;
    }

    for pass in 0..PASSES {
        let forwards = pass % 2 == 0;
        let sequence: Vec<usize> = if forwards {
            (0..hole.order.len()).collect()
        } else {
            (0..hole.order.len()).rev().collect()
        };

        for &at in &sequence {
            let index = hole.order[at];
            let tx = (index as i32) % width;
            let ty = (index as i32) / width;
            let mut best = field[at];
            let mut least = cost(&work, (width, height), (tx, ty), best, f32::INFINITY);

            // Propagation: a patch that suited the pixel next door, shifted by
            // the step between them, is very often the answer here. This is what
            // makes the search cheap — coherent regions are solved by one good
            // match spreading rather than by every pixel finding its own.
            let step = if forwards { -1 } else { 1 };
            for (nx, ny) in [(tx + step, ty), (tx, ty + step)] {
                if nx < 0 || ny < 0 || nx >= width || ny >= height {
                    continue;
                }
                let neighbour = slot[(ny * width + nx) as usize];
                if neighbour == usize::MAX {
                    continue;
                }
                let (sx, sy) = field[neighbour];
                let (px, py) = (sx + (tx - nx), sy + (ty - ny));
                if !usable(&allowed, width, height, px, py) {
                    continue;
                }
                let candidate = cost(&work, (width, height), (tx, ty), (px, py), least);
                if candidate < least {
                    least = candidate;
                    best = (px, py);
                }
            }

            // Random search, at halving distances around the current best. The
            // wide tries escape a local answer; the narrow ones settle it.
            let mut span = width.max(height);
            for _ in 0..ATTEMPTS {
                if span < 1 {
                    break;
                }
                let px = best.0 + noise.below(span * 2 + 1) - span;
                let py = best.1 + noise.below(span * 2 + 1) - span;
                span /= 2;
                if !usable(&allowed, width, height, px, py) {
                    continue;
                }
                let candidate = cost(&work, (width, height), (tx, ty), (px, py), least);
                if candidate < least {
                    least = candidate;
                    best = (px, py);
                }
            }

            field[at] = best;
        }

        // Vote: every patch that covers a hole pixel has an opinion about it, and
        // the fill is their mean. Taking the centre of one patch instead leaves
        // the seams between neighbouring patches visible as a blocky edge.
        let mut sum = vec![0.0f32; count * 3];
        let mut weight = vec![0.0f32; count];
        for (at, &index) in hole.order.iter().enumerate() {
            let tx = (index as i32) % width;
            let ty = (index as i32) / width;
            let (sx, sy) = field[at];
            for dy in -PATCH..=PATCH {
                for dx in -PATCH..=PATCH {
                    let ax = tx + dx;
                    let ay = ty + dy;
                    if ax < 0 || ay < 0 || ax >= width || ay >= height {
                        continue;
                    }
                    let target = (ay * width + ax) as usize;
                    if !hole.inside[target] {
                        continue;
                    }
                    let source = (((sy + dy) * width + sx + dx) * 4) as usize;
                    for channel in 0..3 {
                        sum[target * 3 + channel] += work[source + channel];
                    }
                    weight[target] += 1.0;
                }
            }
        }
        for &index in &hole.order {
            if weight[index] <= 0.0 {
                continue;
            }
            for channel in 0..3 {
                work[index * 4 + channel] = sum[index * 3 + channel] / weight[index];
            }
        }
    }

    // Settle: take each pixel from its own patch rather than from the mean of
    // every patch covering it.
    //
    // The votes above are what make neighbouring patches agree, and they are
    // also what costs the fill its texture — a mean of overlapping patches is a
    // blur by another name, and measured on skin it came back with three fifths
    // of the surrounding detail. A patch of skin missing half its pores is the
    // plastic-skin failure the whole pipeline is built to avoid, and it would be
    // absurd to reintroduce it in the one stage whose job is to leave texture
    // behind. Copying the centre restores it in full, and the field it copies
    // through has already been harmonised by the passes above, which is what
    // keeps the seams between neighbours from showing.
    for (at, &index) in hole.order.iter().enumerate() {
        let (sx, sy) = field[at];
        let source = ((sy * width + sx) * 4) as usize;
        for channel in 0..3 {
            work[index * 4 + channel] = work[source + channel];
        }
    }

    // Back into the region, through the soft edge. The pixels outside the hole
    // are moved too, by as much of the fill as their coverage asks for, which is
    // what keeps the join off the eye.
    let mut touched = 0u32;
    for index in 0..count {
        let alpha = hole.coverage[index];
        if alpha <= 0.0 {
            continue;
        }
        touched += 1;
        for channel in 0..3 {
            let at = index * 4 + channel;
            let was = pixels[at] as f32;
            let now = was + (work[at] - was) * alpha;
            pixels[at] = now.round().clamp(0.0, 255.0) as u8;
        }
    }
    touched
}
