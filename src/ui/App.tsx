import { useCallback, useRef, useState } from 'react';
import { resolveAspect } from '../core/geometry/aspects';
import { normalisedRatio } from '../core/geometry/transform';
import { I18nProvider, useI18n } from '../i18n';
import { CropPanel } from './components/CropPanel';
import { StatusBar, Toast, ToolRail, TopBar } from './components/chrome';
import { DetailPanel } from './components/DetailPanel';
import { ExportPanel } from './components/ExportPanel';
import { Guide, guideSeen, rememberGuideSeen } from './components/Guide';
import { MetadataPanel } from './components/MetadataPanel';
import { CropOverlay, TextOverlay, TileOverlay } from './components/overlays';
import { SimplePanel } from './components/SimplePanel';
import { Stage } from './components/Stage';
import { TextPanel } from './components/TextPanel';
import { TilesPanel } from './components/TilesPanel';
import { ThemeProvider } from './theme';
import { useEditor } from './useEditor';

export function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <Workspace />
      </I18nProvider>
    </ThemeProvider>
  );
}

function Workspace() {
  const { t } = useI18n();
  const editor = useEditor();
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Opened by itself on a first visit and never again on its own. Asking for it
  // from the bar is a different state, because the buttons on the first step
  // read differently when the guide was wanted rather than served.
  const [guide, setGuide] = useState<'first' | 'asked' | null>(() =>
    guideSeen() ? null : 'first',
  );
  const closeGuide = useCallback(() => {
    setGuide(null);
    rememberGuideSeen();
  }, []);
  const openPhoto = useCallback(() => fileInput.current?.click(), []);

  const dimensions = editor.source
    ? `${editor.source.width} × ${editor.source.height} · ${
        editor.source.space === 'display-p3' ? 'P3' : 'sRGB'
      }`
    : null;

  const lockedRatio = resolveAspect(editor.recipe.geometry.aspect, editor.frameAspect);

  return (
    <div className="app">
      <TopBar
        fileName={editor.source?.fileName ?? null}
        dimensions={dimensions}
        tool={editor.tool}
        mode={editor.mode}
        canExport={editor.source !== null}
        exporting={editor.exporting}
        onMode={editor.setMode}
        onOpen={openPhoto}
        onExport={editor.runExport}
        onHelp={() => setGuide('asked')}
      />

      <ToolRail
        tool={editor.tool}
        comparing={editor.comparing}
        onTool={editor.setTool}
        onCompare={editor.setComparing}
        disabled={editor.source === null}
      />

      {editor.fatal ? (
        <div className="stage">
          <div className="dropzone">
            <b>{t('fatal.title')}</b>
            <span>{t('fatal.body')}</span>
            <span className="mono">{editor.fatal}</span>
          </div>
        </div>
      ) : (
        <Stage
          canvasRef={editor.canvasRef}
          viewportRef={editor.viewportRef}
          hasImage={editor.source !== null}
          comparing={editor.comparing}
          tool={editor.tool}
          overlay={
            <>
              {editor.tool === 'crop' && (
                <CropOverlay
                  crop={editor.recipe.geometry.crop}
                  ratio={
                    lockedRatio === null ? null : normalisedRatio(lockedRatio, editor.frameAspect)
                  }
                  onChange={editor.setCrop}
                />
              )}
              {editor.tool === 'text' && (
                <TextOverlay
                  layers={editor.recipe.text}
                  selected={editor.selectedText}
                  onSelect={editor.selectText}
                  onMove={(id, x, y) => editor.updateText(id, { x, y })}
                />
              )}
              {(editor.tool === 'tiles' || editor.tool === 'crop') && editor.plan && (
                <TileOverlay
                  tiles={editor.plan.tiles}
                  width={editor.plan.width}
                  height={editor.plan.height}
                />
              )}
            </>
          }
          onCompare={editor.setComparing}
          onFiles={editor.openFiles}
          onPick={openPhoto}
          onHelp={() => setGuide('asked')}
        />
      )}

      <aside className="panel">
        {editor.tool === 'adjust' &&
          (editor.mode === 'simple' ? (
            <SimplePanel
              thumbnails={editor.thumbnails}
              look={editor.look}
              strength={editor.strength}
              metadataMode={editor.recipe.output.metadata.mode}
              hasImage={editor.source !== null}
              faceState={editor.faceState}
              onLook={editor.setLook}
              onStrength={editor.setStrength}
              onAuto={editor.runAuto}
              onRetryFace={editor.retryFaceAnalysis}
              onMetadataMode={(mode) => editor.setMetadata({ mode })}
              onDetail={() => editor.setMode('detail')}
            />
          ) : (
            <DetailPanel
              recipe={editor.recipe}
              toneResponse={editor.toneResponse}
              faceState={editor.faceState}
              faceCount={editor.faceCount}
              onParam={editor.setParam}
              onRetryFace={editor.retryFaceAnalysis}
              onSimple={() => editor.setMode('simple')}
            />
          ))}

        {editor.tool === 'crop' && (
          <CropPanel
            geometry={editor.recipe.geometry}
            plan={editor.plan}
            hasImage={editor.source !== null}
            onGeometry={editor.setGeometry}
            onAspect={editor.setAspect}
            onRotate={editor.rotate}
            onFlip={editor.flip}
            onReset={editor.resetFraming}
          />
        )}

        {editor.tool === 'text' && (
          <TextPanel
            layers={editor.recipe.text}
            selected={editor.selectedText}
            hasImage={editor.source !== null}
            fontRevision={editor.fontRevision}
            onAdd={editor.addText}
            onSelect={editor.selectText}
            onUpdate={editor.updateText}
            onRemove={editor.removeText}
            onLoadFont={editor.loadFont}
          />
        )}

        {editor.tool === 'tiles' && (
          <TilesPanel
            tiles={editor.recipe.tiles}
            plan={editor.plan}
            hasImage={editor.source !== null}
            onTiles={editor.setTiles}
            onMatchCrop={editor.matchCropToTiles}
          />
        )}

        {editor.tool === 'metadata' && (
          <MetadataPanel
            metadata={editor.recipe.output.metadata}
            format={editor.recipe.output.format}
            source={editor.source?.exif ?? null}
            onMetadata={editor.setMetadata}
          />
        )}

        {editor.tool === 'export' && (
          <ExportPanel
            output={editor.recipe.output}
            plan={editor.plan}
            hasImage={editor.source !== null}
            exporting={editor.exporting}
            onOutput={editor.setOutput}
            onExport={editor.runExport}
            onMetadataTool={() => editor.setTool('metadata')}
          />
        )}
      </aside>

      <StatusBar
        stats={editor.stats}
        scale={editor.scale}
        previewSize={editor.previewSize}
        workingSpace={editor.workingSpace}
      />

      <Toast
        message={
          editor.toast
            ? { id: editor.toast.id, body: editor.toast.body, tone: editor.toast.tone }
            : null
        }
      />

      {/* A browser that cannot run the editor has nothing to be guided through. */}
      {!editor.fatal && (
        <Guide
          open={guide !== null}
          firstRun={guide === 'first'}
          onClose={closeGuide}
          onOpenPhoto={openPhoto}
        />
      )}

      <input
        ref={fileInput}
        type="file"
        accept="image/*,.heic,.heif"
        hidden
        onChange={(event) => {
          if (event.target.files?.length) editor.openFiles(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
}
