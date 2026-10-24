window.__ModuleLoader__.load({
  id: '@local/dsh-great-plan',
  chunk: 'client.ui.js',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const { useEffect, useLayoutEffect, useRef, useState } = React;

    const STYLE_ID = '@local/dsh-great-plan/ui.css';

    const CSS = `
.gp-trigger{font:inherit;color:inherit;background:none;border:0;padding:0;display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap}
.gp-trigger:hover{opacity:.78}
.gp-trigger:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:3px;border-radius:4px}
.gp-trigger-chevron{opacity:.65}
.gp-backdrop{position:fixed;inset:0;z-index:1200;background:transparent}
.gp-dialog{position:fixed;z-index:1201;display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl,16px);box-shadow:var(--dsw-elevation-panel);overflow:hidden;font-family:inherit}
.gp-dialog,.gp-dialog *{box-sizing:border-box}
.gp-dialog-header{display:flex;align-items:flex-start;gap:8px;padding:14px 12px 8px 14px;flex:none}
.gp-dialog-title-wrap{flex:1;min-width:0}
.gp-dialog-title{font-size:15px;font-weight:500;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gp-dialog-subtitle{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.gp-dialog-body{padding:2px 8px 10px;overflow-y:auto;min-height:0;flex:1 1 auto;scrollbar-width:thin}
.gp-icon-button{width:24px;height:24px;border:0;border-radius:999px;background:none;color:var(--dsw-alias-label-tertiary);display:grid;place-items:center;padding:0;cursor:pointer;flex:none}
.gp-icon-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.gp-icon-button:disabled{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));cursor:default}
.gp-icon-button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.gp-row{display:flex;align-items:center;gap:10px;width:100%;min-height:42px;padding:7px 8px;border:0;border-radius:var(--dsw-radius-md,8px);background:none;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.gp-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.gp-row:disabled{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));cursor:default}
.gp-row:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}
.gp-row-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.gp-row-title{font-size:13px;line-height:20px}
.gp-row-desc{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gp-row-value{margin-left:auto;min-width:0;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.gp-row-chevron{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));flex:none}
.gp-list{padding:2px 0}
.gp-group-heading{position:sticky;top:0;z-index:1;padding:9px 8px 4px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.gp-list-row{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-md,8px);background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.gp-list-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.gp-list-row:disabled{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));cursor:default}
.gp-list-row:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}
.gp-list-check{width:16px;height:16px;flex:none;display:grid;place-items:center;color:var(--dsw-alias-brand-primary)}
.gp-list-row-title{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.gp-list-row-desc{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gp-separator{height:1px;margin:6px 8px;background:var(--dsw-alias-border-l1)}
.gp-actions{display:flex;flex-direction:column;gap:7px;padding:2px 0 4px}
.gp-action{display:flex;align-items:center;gap:10px;width:100%;min-height:56px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.gp-action:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.gp-action:disabled{opacity:.55;cursor:default}
.gp-action:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.gp-action-primary{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,var(--dsw-alias-border-l1))}
.gp-action-icon{width:30px;height:30px;flex:none;display:grid;place-items:center;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.gp-action-primary .gp-action-icon{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-brand-primary)}
.gp-action-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.gp-action-title{font-size:13px;font-weight:500;line-height:19px}
.gp-action-desc{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.gp-action-chevron{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));flex:none}
.gp-note{padding:8px 8px 4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.gp-footer-note{padding:4px 8px 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.gp-error{margin:4px 0;padding:7px 9px;border-radius:var(--dsw-radius-md,8px);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:17px;overflow-wrap:anywhere}
.gp-warning{margin:4px 0;padding:7px 9px;border-radius:var(--dsw-radius-md,8px);color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:17px;overflow-wrap:anywhere}
.gp-warning-box{margin:2px 0 8px;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:17px;display:flex;gap:7px;align-items:flex-start}
.gp-warning-box svg{flex:none;margin-top:2px;color:var(--dsw-alias-state-warn-primary)}
.gp-loading{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.gp-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:gp-pulse 1.2s ease-in-out infinite;flex:none}
.gp-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:5px 12px;border:1px solid transparent;border-radius:var(--dsw-radius-md,8px);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.gp-button-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
.gp-button-primary:hover:not(:disabled){opacity:.88}
.gp-button-outline{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-primary)}
.gp-button-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.gp-button-ghost{background:none;color:var(--dsw-alias-label-secondary)}
.gp-button-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.gp-button:disabled{opacity:.5;cursor:default}
.gp-button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.gp-button-full{width:100%}
.gp-static-row{display:flex;align-items:flex-start;gap:10px;width:100%;min-height:38px;padding:7px 8px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left}
.gp-static-label{font-size:13px;line-height:20px;flex:none}
.gp-static-value{margin-left:auto;min-width:0;max-width:64%;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere;text-align:right}
.gp-clear-actions{padding:4px 0 2px}
@media (max-width:720px){.gp-trigger-label,.gp-trigger-chevron{display:none}.gp-trigger{padding:3px}.gp-dialog{max-height:calc(100vh - 24px)}}
@media (prefers-reduced-motion:reduce){.gp-dot{animation:none}}
@keyframes gp-pulse{0%,100%{opacity:.35}50%{opacity:1}}
`;

    function installStyles() {
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {};
      const style = document.createElement('style');
      style.dataset.plugin = '@local/dsh-great-plan';
      style.dataset.pluginCss = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
    }

    function cx(...parts) {
      return parts.filter(Boolean).join(' ');
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    function useStore(store) {
      return React.useSyncExternalStore(
        (listener) => store.subscribe(listener),
        () => store.getSnapshot(),
        () => store.getSnapshot(),
      );
    }

    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set: (next) => {
          value = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    function iconProps(size, className) {
      return {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        className,
      };
    }

    function IconSliders({ size = 16, className }) {
      return h('svg', iconProps(size, className),
        h('path', { d: 'M2 4h12M2 8h12M2 12h12' }),
        h('circle', { cx: 6, cy: 4, r: 1.75, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 10, cy: 8, r: 1.75, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 5, cy: 12, r: 1.75, fill: 'currentColor', stroke: 'none' }),
      );
    }

    function IconChevronRight({ size = 14, className }) {
      return h('svg', iconProps(size, className), h('path', { d: 'M6 3l5 5-5 5' }));
    }

    function IconChevronDown({ size = 14, className }) {
      return h('svg', iconProps(size, className), h('path', { d: 'M4 6l4 4 4-4' }));
    }

    function IconChevronLeft({ size = 14, className }) {
      return h('svg', iconProps(size, className), h('path', { d: 'M10 3L5 8l5 5' }));
    }

    function IconClose({ size = 16, className }) {
      return h('svg', iconProps(size, className), h('path', { d: 'M4 4l8 8M12 4l-8 8' }));
    }

    function IconCheck({ size = 14, className }) {
      return h('svg', iconProps(size, className), h('path', { d: 'M3 8.5l3 3 7-7' }));
    }

    function IconPlay({ size = 16, className }) {
      return h('svg', iconProps(size, className), h('path', { d: 'M5 3.5l7 4.5-7 4.5z', fill: 'currentColor', stroke: 'none' }));
    }

    function IconCompress({ size = 16, className }) {
      return h('svg', iconProps(size, className),
        h('path', { d: 'M2 5h12v8H2z' }),
        h('path', { d: 'M2 5l1.5-2h9L14 5' }),
        h('path', { d: 'M6 9h4' }),
      );
    }

    function IconNewSession({ size = 16, className }) {
      return h('svg', iconProps(size, className),
        h('rect', { x: 2, y: 4, width: 8, height: 8, rx: 1.5 }),
        h('path', { d: 'M12 8v5M9.5 10.5h5' }),
      );
    }

    function IconWarning({ size = 14, className }) {
      return h('svg', iconProps(size, className),
        h('path', { d: 'M8 2.5l6 11H2z' }),
        h('path', { d: 'M8 6.5v3.5M8 12v.2' }),
      );
    }

    function IconButton({ label, title, onClick, disabled, autoFocus, className, children }) {
      return h('button', {
        type: 'button',
        className: cx('gp-icon-button', className),
        'aria-label': label,
        title: title ?? label,
        'data-autofocus': autoFocus ? true : undefined,
        disabled,
        onClick,
      }, children);
    }

    function Button({ variant = 'ghost', full = false, className, children, ...rest }) {
      return h('button', {
        type: 'button',
        className: cx('gp-button', `gp-button-${variant}`, full && 'gp-button-full', className),
        ...rest,
      }, children);
    }

    function ActionRow({ icon, title, description, primary = false, disabled = false, onClick }) {
      return h('button', {
        type: 'button',
        className: cx('gp-action', primary && 'gp-action-primary'),
        disabled,
        onClick,
      },
      h('span', { className: 'gp-action-icon' }, icon),
      h('span', { className: 'gp-action-copy' },
        h('span', { className: 'gp-action-title' }, title),
        h('span', { className: 'gp-action-desc' }, description),
      ),
      h(IconChevronRight, { className: 'gp-action-chevron' }),
      );
    }

    function SelectRow({ label, value, description, onClick, disabled = false }) {
      return h('button', {
        type: 'button',
        className: 'gp-row',
        disabled,
        onClick,
      },
      h('span', { className: 'gp-row-copy' },
        h('span', { className: 'gp-row-title' }, label),
        description === undefined ? null : h('span', { className: 'gp-row-desc' }, description),
      ),
      h('span', { className: 'gp-row-value' }, value),
      h(IconChevronRight, { className: 'gp-row-chevron' }),
      );
    }

    function StaticRow({ label, value }) {
      return h('div', { className: 'gp-static-row' },
        h('span', { className: 'gp-static-label' }, label),
        h('span', { className: 'gp-static-value' }, value),
      );
    }

    function ListRow({ title, description, selected = false, disabled = false, onClick }) {
      return h('button', {
        type: 'button',
        className: 'gp-list-row',
        disabled,
        onClick,
        'aria-pressed': selected,
      },
      h('span', { className: 'gp-list-check' }, selected ? h(IconCheck) : null),
      h('span', { className: 'gp-list-row-title' },
        h('span', null, title),
        description === undefined ? null : h('span', { className: 'gp-list-row-desc' }, description),
      ),
      );
    }

    function GroupHeading({ children }) {
      return h('div', { className: 'gp-group-heading' }, children);
    }

    function Note({ children, className }) {
      return h('div', { className: cx('gp-note', className) }, children);
    }

    function ErrorText({ children }) {
      return h('div', { className: 'gp-error', role: 'alert' }, children);
    }

    function WarningText({ children }) {
      return h('div', { className: 'gp-warning', role: 'status' }, children);
    }

    function WarningBox({ children }) {
      return h('div', { className: 'gp-warning-box' }, h(IconWarning), h('span', null, children));
    }

    function Loading({ children }) {
      return h('span', { className: 'gp-loading' }, h('span', { className: 'gp-dot' }), children);
    }

    function useAnchoredPosition(open, anchorRef, panelRef, setPosition) {
      useLayoutEffect(() => {
        if (!open) {
          setPosition(null);
          return undefined;
        }
        let frame = 0;
        const update = () => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            const anchor = anchorRef.current;
            const panel = panelRef.current;
            if (anchor === null || panel === null) return;
            const rect = anchor.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const width = Math.max(280, Math.min(380, viewportWidth - 24));
            const panelHeight = panel.offsetHeight;
            let left;
            let top;
            if (viewportWidth <= 720) {
              left = Math.max(12, (viewportWidth - width) / 2);
              top = Math.max(12, (viewportHeight - panelHeight) / 2);
            } else {
              left = Math.min(Math.max(12, rect.right - width), viewportWidth - width - 12);
              top = rect.bottom + 8;
              if (top + panelHeight > viewportHeight - 12) top = Math.max(12, rect.top - panelHeight - 8);
            }
            setPosition({ top, left, width, maxHeight: Math.max(240, viewportHeight - 24) });
          });
        };
        update();
        const observer = typeof ResizeObserver === 'function' && panelRef.current !== null ? new ResizeObserver(update) : null;
        observer?.observe(panelRef.current);
        window.addEventListener('resize', update);
        const onScroll = (event) => {
          if (panelRef.current !== null && event.target instanceof Node && panelRef.current.contains(event.target)) return;
          update();
        };
        window.addEventListener('scroll', onScroll, true);
        return () => {
          cancelAnimationFrame(frame);
          observer?.disconnect();
          window.removeEventListener('resize', update);
          window.removeEventListener('scroll', onScroll, true);
        };
      }, [open, anchorRef, panelRef, setPosition]);
    }

    function useDialogFocus(open, panelRef, anchorRef, onClose, blocked) {
      const blockedRef = useRef(blocked);
      blockedRef.current = blocked;
      const onCloseRef = useRef(onClose);
      onCloseRef.current = onClose;
      useEffect(() => {
        if (!open) return undefined;
        const panel = panelRef.current;
        const previous = document.activeElement;
        const focusables = () => {
          if (panel === null) return [];
          return [...panel.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
            .filter((node) => node instanceof HTMLElement && node.offsetParent !== null);
        };
        const first = panel?.querySelector('[data-autofocus]') ?? focusables()[0];
        first?.focus();
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            if (!blockedRef.current) {
              event.preventDefault();
              event.stopPropagation();
              onCloseRef.current();
            }
            return;
          }
          if (event.key !== 'Tab') return;
          const list = focusables();
          if (list.length === 0) {
            event.preventDefault();
            return;
          }
          const firstNode = list[0];
          const lastNode = list[list.length - 1];
          const active = document.activeElement;
          if (event.shiftKey && (active === firstNode || panel?.contains(active) !== true)) {
            event.preventDefault();
            lastNode.focus();
          } else if (!event.shiftKey && (active === lastNode || panel?.contains(active) !== true)) {
            event.preventDefault();
            firstNode.focus();
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          const restore = anchorRef.current instanceof HTMLElement && anchorRef.current.isConnected ? anchorRef.current : previous;
          if (restore instanceof HTMLElement && restore.isConnected) restore.focus();
        };
      }, [open, panelRef, anchorRef]);
    }

    function Dialog({ open, onRequestClose, blocked, anchorRef, labelledBy, children }) {
      const panelRef = useRef(null);
      const [position, setPosition] = useState(null);
      useAnchoredPosition(open, anchorRef, panelRef, setPosition);
      useDialogFocus(open, panelRef, anchorRef, onRequestClose, blocked);
      if (!open) return null;
      return ReactDOM.createPortal(
        h(React.Fragment, null,
          h('div', {
            className: 'gp-backdrop',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget && !blocked) onRequestClose();
            },
          }),
          h('div', {
            ref: panelRef,
            className: 'gp-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': labelledBy,
            style: position ?? { top: 0, left: 0, opacity: 0 },
          }, children),
        ),
        document.body,
      );
    }

    return {
      installStyles,
      cx,
      messageOf,
      useStore,
      createStore,
      IconSliders,
      IconChevronRight,
      IconChevronDown,
      IconChevronLeft,
      IconClose,
      IconCheck,
      IconPlay,
      IconCompress,
      IconNewSession,
      IconWarning,
      IconButton,
      Button,
      ActionRow,
      SelectRow,
      StaticRow,
      ListRow,
      GroupHeading,
      Note,
      ErrorText,
      WarningText,
      WarningBox,
      Loading,
      Dialog,
    };
  },
});
