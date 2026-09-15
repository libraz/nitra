/**
 * Window chrome: the bar, the rail, the status strip and the toast.
 */

import type { ReactNode } from 'react';
import { RESHAPE_WARNING } from '../../core/face/warp';
import type { RenderStats } from '../../core/render/pipeline';
import { LOCALE_ORDER, LOCALES, type MessageKey, useI18n } from '../../i18n';
import { THEME_CHOICES, useTheme } from '../theme';
import type { Tool } from '../useEditor';
import { Menu } from './menu';

interface TopBarProps {
  fileName: string | null;
  dimensions: string | null;
  tool: Tool;
  mode: 'simple' | 'detail';
  canExport: boolean;
  exporting: boolean;
  onMode: (mode: 'simple' | 'detail') => void;
  onOpen: () => void;
  onExport: () => void;
  onHelp: () => void;
}

export function TopBar({
  fileName,
  dimensions,
  tool,
  mode,
  canExport,
  exporting,
  onMode,
  onOpen,
  onExport,
  onHelp,
}: TopBarProps) {
  const { t } = useI18n();
  return (
    <header className="topbar">
      <div className="brand">
        <span className="mark">nitra</span>
      </div>

      <div className="doc">
        <span className="fn">{fileName ?? t('topbar.noFile')}</span>
        {dimensions && <span className="dim mono">{dimensions}</span>}
      </div>

      <div className="spacer" />

      <button
        type="button"
        className="menu-t"
        aria-label={t('topbar.help')}
        data-tip={t('topbar.help')}
        onClick={onHelp}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.4 9.4a2.7 2.7 0 1 1 3.4 2.8c-.5.2-.8.7-.8 1.3v.6" />
          <path d="M12 17.1h.01" />
        </svg>
      </button>

      <ThemePicker />
      <LanguagePicker />

      {tool === 'adjust' && (
        <div className="modes" data-mode={mode} role="tablist" aria-label={t('topbar.modes')}>
          <div className="glide" />
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'simple'}
            onClick={() => onMode('simple')}
          >
            {t('topbar.modeSimple')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'detail'}
            onClick={() => onMode('detail')}
          >
            {t('topbar.modeDetail')}
          </button>
        </div>
      )}

      <button type="button" className="tbtn" onClick={onOpen}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 7h6l2 2h10v10H3z" />
        </svg>
        {t('topbar.open')}
      </button>
      <button
        type="button"
        className="tbtn primary"
        onClick={onExport}
        disabled={!canExport || exporting}
      >
        {t(exporting ? 'topbar.exporting' : 'topbar.export')}
      </button>
    </header>
  );
}

/**
 * Language picker.
 *
 * An icon that opens the list. The bar has room for an icon and not for a
 * control sized to hold the longest language name in every language — and the
 * list grows every time a locale is added, while the icon does not.
 *
 * Each language names itself, in itself. Someone who has landed in a language
 * they do not read is exactly the person reaching for this, and "日本語" is
 * findable to them in a way that "Japanese" is not.
 */
function LanguagePicker() {
  const { locale, setLocale, t } = useI18n();
  return (
    <Menu
      label={t('topbar.language')}
      value={locale}
      onSelect={(code) => setLocale(code as typeof locale)}
      items={LOCALE_ORDER.map((code) => ({ key: code, name: LOCALES[code]['locale.name'] }))}
      trigger={
        <>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3.4 9h17.2M3.4 15h17.2" />
            <path d="M12 3c2.4 2.4 3.6 5.4 3.6 9s-1.2 6.6-3.6 9c-2.4-2.4-3.6-5.4-3.6-9S9.6 5.4 12 3z" />
          </svg>
          <span className="menu-tag">{locale.toUpperCase()}</span>
        </>
      }
    />
  );
}

/**
 * Appearance picker.
 *
 * The icon shows the appearance currently in force, not the setting — under
 * "match system" the setting has no shape to draw, and what the person wants to
 * know at a glance is which one they are looking at.
 */
function ThemePicker() {
  const { choice, appearance, setChoice } = useTheme();
  const { t } = useI18n();
  return (
    <Menu
      label={t('topbar.theme')}
      value={choice}
      onSelect={(next) => setChoice(next as typeof choice)}
      items={THEME_CHOICES.map((value) => ({
        key: value,
        name: t(`theme.${value}` as MessageKey),
      }))}
      trigger={
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {appearance === 'dark' ? (
            <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
          ) : (
            <>
              <circle cx="12" cy="12" r="4.2" />
              <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" />
            </>
          )}
        </svg>
      }
    />
  );
}

interface ToolRailProps {
  tool: Tool;
  comparing: boolean;
  onTool: (tool: Tool) => void;
  onCompare: (on: boolean) => void;
  disabled: boolean;
}

const TOOL_ICONS: Record<Tool, ReactNode> = {
  adjust: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  crop: (
    <>
      <path d="M7 2v15h15" />
      <path d="M2 7h15v15" />
    </>
  ),
  text: (
    <>
      <path d="M5 6h14" />
      <path d="M12 6v13" />
      <path d="M9 19h6" />
    </>
  ),
  tiles: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  metadata: (
    <>
      <path d="M4 5.5h10l6 6.5-6 6.5H4z" />
      <circle cx="8.5" cy="12" r="1.6" />
    </>
  ),
  export: (
    <>
      <path d="M12 3v12" />
      <path d="M8 11l4 4 4-4" />
      <path d="M4 19h16" />
    </>
  ),
};

const TOOL_ORDER: readonly Tool[] = ['adjust', 'crop', 'text', 'tiles', 'metadata', 'export'];

export function ToolRail({ tool, comparing, onTool, onCompare, disabled }: ToolRailProps) {
  const { t } = useI18n();
  return (
    <nav className="rail" aria-label={t('rail.tools')}>
      {TOOL_ORDER.map((key) => (
        <button
          key={key}
          type="button"
          className="tool"
          aria-pressed={key === tool}
          aria-label={t(`tool.${key}` as MessageKey)}
          data-tip={t(`tool.${key}` as MessageKey)}
          onClick={() => onTool(key)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {TOOL_ICONS[key]}
          </svg>
        </button>
      ))}

      <div className="rail-gap" />

      <button
        type="button"
        className="tool"
        aria-pressed={comparing}
        aria-label={t('rail.compare')}
        data-tip={t('rail.compare')}
        disabled={disabled}
        onPointerDown={() => onCompare(true)}
        onPointerUp={() => onCompare(false)}
        onPointerLeave={() => onCompare(false)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M12 4v16" />
        </svg>
      </button>
    </nav>
  );
}

interface StatusBarProps {
  stats: RenderStats | null;
  scale: 'proxy' | 'full';
  previewSize: string | null;
  workingSpace: string;
}

/**
 * The guardrails.
 *
 * Nothing here forbids anything. The readings are measured off the rendered
 * result and shown; a number saying the highlights are gone is enough for
 * someone to pull the slider back themselves.
 */
export function StatusBar({ stats, scale, previewSize, workingSpace }: StatusBarProps) {
  const { t } = useI18n();
  const retention = stats?.textureRetention ?? null;
  // Skin texture is the one gauge that reads the other way up: the others count
  // what has been destroyed and warn as they rise, this one is what survived
  // and warns as it falls. It is also the only one that comes and goes. A
  // landscape has no skin texture to have kept, and a gauge sitting at a full
  // hundred per cent would be a reading of nothing at all — so on a photo with
  // no face in it, it is not there.
  const reshape = stats?.reshapeMagnitude ?? null;
  const gauges = [
    ...(retention === null
      ? []
      : [
          {
            id: 'texture',
            label: t('gauges.texture'),
            value: retention,
            limit: 0.5,
            inverted: true,
          },
        ]),
    // Comes and goes for the same reason the texture reading does: a photo
    // nobody is reshaping has no displacement to report, and a bar sitting at
    // zero would claim to be measuring one.
    ...(reshape === null
      ? []
      : [
          {
            id: 'reshape',
            label: t('gauges.reshape'),
            value: reshape,
            limit: RESHAPE_WARNING,
            inverted: false,
          },
        ]),
    {
      id: 'blow',
      label: t('gauges.blowout'),
      value: stats ? stats.highlightClip : null,
      limit: 0.02,
      inverted: false,
    },
    {
      id: 'crush',
      label: t('gauges.crush'),
      value: stats ? stats.shadowClip : null,
      limit: 0.04,
      inverted: false,
    },
    {
      id: 'chroma',
      label: t('gauges.chroma'),
      value: stats ? stats.chromaClip : null,
      limit: 0.01,
      inverted: false,
    },
  ];

  return (
    <footer className="foot">
      <div className="gauges">
        {gauges.map((gauge) => {
          if (gauge.value === null) {
            return (
              <div className="g" key={gauge.id} data-state="idle">
                <span className="gl">{gauge.label}</span>
                <span className="gbar">
                  <i style={{ width: '0%' }} />
                </span>
                <span className="gv mono">—</span>
              </div>
            );
          }
          const over = gauge.inverted ? gauge.value < gauge.limit : gauge.value > gauge.limit;
          const fill = gauge.inverted
            ? gauge.value
            : Math.min(1, gauge.value / (gauge.limit * 2.4));
          return (
            <div className="g" key={gauge.id} data-state={over ? 'warn' : 'ok'}>
              <span className="gl">{gauge.label}</span>
              <span className="gbar">
                <i style={{ width: `${fill * 100}%` }} />
              </span>
              <span className="gv mono">{`${(gauge.value * 100).toFixed(1)}%`}</span>
            </div>
          );
        })}
      </div>
      <div className="spacer" />
      <div className="rt mono">
        <span>
          {t('status.view')} <b>{t(scale === 'full' ? 'status.viewFull' : 'status.viewProxy')}</b>
        </span>
        {previewSize && (
          <span>
            {t('status.evaluated')} <b>{previewSize}</b>
          </span>
        )}
        <span>
          {t('status.workingSpace')} <b>{workingSpace}</b>
        </span>
      </div>
    </footer>
  );
}

export interface ToastMessage {
  id: number;
  body: ReactNode;
  tone?: 'normal' | 'alert';
}

export function Toast({ message }: { message: ToastMessage | null }) {
  return (
    <div
      className="toast"
      data-on={message !== null}
      data-tone={message?.tone ?? 'normal'}
      role="status"
      aria-live="polite"
    >
      {message?.body}
    </div>
  );
}
