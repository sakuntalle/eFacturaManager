import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode, TableHTMLAttributes, ThHTMLAttributes } from 'react';

type Column = { id: string; label: string; defaultWidth: number; minWidth?: number; maxAutoWidth?: number;
    autoFitLines?: number; autoFitSelector?: string; fillRemaining?: boolean };
type Widths = Record<string, number>;
type WidthPreference = { widths: Widths; customized: string[] };
type ResizeContextValue = {
    columns: Column[];
    startResize: (columnId: string, event: PointerEvent<HTMLSpanElement>) => void;
    continueResize: (event: PointerEvent<HTMLSpanElement>) => void;
    finishResize: (event: PointerEvent<HTMLSpanElement>) => void;
    resizeWithKeyboard: (columnId: string, event: KeyboardEvent<HTMLSpanElement>) => void;
    fitColumn: (columnId: string) => void;
};

const ResizeContext = createContext<ResizeContextValue | null>(null);
const storagePrefix = 'efactura-manager:table-widths:';

function storedPreference(tableId: string, columns: Column[]): WidthPreference {
    const defaults = Object.fromEntries(columns.map(column => [column.id, column.defaultWidth]));
    try {
        const stored = JSON.parse(localStorage.getItem(`${storagePrefix}${tableId}`) ?? '{}') as {
            version?: unknown;
            widths?: Record<string, unknown>;
        };
        if (stored.version === 2 && stored.widths) {
            const customized: string[] = [];
            for (const [columnId, width] of Object.entries(stored.widths)) {
                if (typeof width === 'number' && Number.isFinite(width)) {
                    defaults[columnId] = Math.max(24, Math.min(width, 1600));
                    customized.push(columnId);
                }
            }
            for (const column of columns) {
                const width = stored.widths[column.id];
                if (typeof width === 'number' && Number.isFinite(width)) {
                    defaults[column.id] = Math.max(column.minWidth ?? 72, Math.min(width, 1600));
                }
            }
            return { widths: defaults, customized };
        }
    } catch {
        // Ignore obsolete or malformed local preferences and use the defaults.
    }
    return { widths: defaults, customized: [] };
}

export function ResizableTable({ tableId, columns, className = '', children, ...props }: TableHTMLAttributes<HTMLTableElement> & {
    tableId: string;
    columns: Column[];
    children: ReactNode;
}) {
    const table = useRef<HTMLTableElement>(null);
    const [preference, setPreference] = useState<WidthPreference>(() => storedPreference(tableId, columns));
    const [availableWidth, setAvailableWidth] = useState(0);
    const drag = useRef<{ columnId: string; startX: number; startWidth: number } | null>(null);
    const columnSignature = columns.map(column =>
        `${column.id}:${column.defaultWidth}:${column.minWidth ?? 72}:${column.maxAutoWidth ?? 480}`
        + `:${column.autoFitLines ?? 0}:${column.autoFitSelector ?? ''}:${column.fillRemaining ?? false}`).join('|');

    useEffect(() => {
        const customizedWidths = Object.fromEntries(preference.customized
            .filter(columnId => preference.widths[columnId] !== undefined)
            .map(columnId => [columnId, preference.widths[columnId]]));
        localStorage.setItem(`${storagePrefix}${tableId}`, JSON.stringify({ version: 2, widths: customizedWidths }));
    }, [tableId, preference]);

    function measuredWidths() {
        const next = { ...preference.widths };
        for (const header of table.current?.querySelectorAll<HTMLElement>('th[data-resizable-column]') ?? []) {
            const columnId = header.dataset.resizableColumn;
            if (columnId) next[columnId] = Math.round(header.getBoundingClientRect().width);
        }
        return next;
    }

    function autoWidths() {
        const source = table.current;
        if (!source) return {};
        const wrapper = document.createElement('div');
        const clone = source.cloneNode(true) as HTMLTableElement;
        wrapper.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;width:max-content;';
        clone.querySelector('colgroup')?.remove();
        clone.querySelector('.bulk-actions-row')?.remove();
        clone.querySelectorAll('.column-resize-handle').forEach(handle => handle.remove());
        clone.style.width = 'max-content';
        clone.style.minWidth = '0';
        clone.style.tableLayout = 'auto';
        wrapper.append(clone);
        document.body.append(wrapper);
        const measured: Widths = {};
        for (const column of columns) {
            const header = clone.querySelector<HTMLElement>(`th[data-resizable-column="${column.id}"]`);
            if (header) measured[column.id] = Math.max(column.minWidth ?? 72,
                Math.min(Math.ceil(header.getBoundingClientRect().width), column.maxAutoWidth ?? 480));
            if (!column.autoFitLines || !column.autoFitSelector) continue;
            const values = [...source.querySelectorAll<HTMLElement>(column.autoFitSelector)]
                .filter(element => element.textContent?.trim());
            if (!values.length) continue;
            const sampleStyle = getComputedStyle(values[0]);
            const cellStyle = getComputedStyle(values[0].closest('td')!);
            const horizontalPadding = Number.parseFloat(cellStyle.paddingLeft) + Number.parseFloat(cellStyle.paddingRight);
            const probe = document.createElement('div');
            probe.style.position = 'absolute';
            probe.style.display = 'block';
            probe.style.font = sampleStyle.font;
            probe.style.fontWeight = sampleStyle.fontWeight;
            probe.style.letterSpacing = sampleStyle.letterSpacing;
            probe.style.lineHeight = sampleStyle.lineHeight;
            probe.style.overflowWrap = sampleStyle.overflowWrap;
            probe.style.wordBreak = sampleStyle.wordBreak;
            wrapper.append(probe);
            probe.style.width = 'max-content';
            probe.style.whiteSpace = 'nowrap';
            const widestText = values.reduce((widest, element) => {
                probe.textContent = element.textContent;
                return Math.max(widest, Math.ceil(probe.getBoundingClientRect().width));
            }, 0);
            const minimum = column.minWidth ?? 72;
            let low = minimum;
            let high = Math.min(1600, Math.max(minimum, widestText + horizontalPadding));
            probe.style.whiteSpace = 'normal';
            const lineHeight = Number.parseFloat(sampleStyle.lineHeight);
            const fits = (width: number) => values.every(element => {
                probe.style.width = `${Math.max(1, width - horizontalPadding)}px`;
                probe.textContent = element.textContent;
                return probe.getBoundingClientRect().height <= lineHeight * column.autoFitLines! + .5;
            });
            while (low < high) {
                const middle = Math.floor((low + high) / 2);
                if (fits(middle)) high = middle;
                else low = middle + 1;
            }
            measured[column.id] = low;
        }
        wrapper.remove();
        return measured;
    }

    useLayoutEffect(() => {
        const measured = autoWidths();
        setPreference(current => {
            const next = { ...current.widths };
            let changed = false;
            for (const column of columns) {
                if (!current.customized.includes(column.id) && measured[column.id] !== undefined
                    && next[column.id] !== measured[column.id]) {
                    next[column.id] = measured[column.id];
                    changed = true;
                }
            }
            return changed ? { ...current, widths: next } : current;
        });
    });

    useLayoutEffect(() => {
        const container = table.current?.parentElement;
        if (!container) return;
        const measure = () => setAvailableWidth(container.clientWidth);
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        measure();
        return () => observer.disconnect();
    }, []);

    function setColumnWidth(columnId: string, width: number, baseline?: Widths) {
        const column = columns.find(item => item.id === columnId);
        if (!column) return;
        const minimum = column.minWidth ?? 72;
        setPreference(current => ({
            widths: { ...(baseline ?? current.widths), [columnId]: Math.max(minimum, Math.min(Math.round(width), 1600)) },
            customized: current.customized.includes(columnId) ? current.customized : [...current.customized, columnId],
        }));
    }

    const context = useMemo<ResizeContextValue>(() => ({
        columns,
        startResize(columnId, event) {
            event.preventDefault();
            const measured = measuredWidths();
            setPreference(current => ({ ...current, widths: measured }));
            drag.current = { columnId, startX: event.clientX, startWidth: measured[columnId] };
            event.currentTarget.setPointerCapture(event.pointerId);
        },
        continueResize(event) {
            if (!drag.current) return;
            setColumnWidth(drag.current.columnId,
                drag.current.startWidth + event.clientX - drag.current.startX);
        },
        finishResize(event) {
            if (!drag.current) return;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            drag.current = null;
        },
        resizeWithKeyboard(columnId, event) {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const measured = measuredWidths();
            setColumnWidth(columnId, measured[columnId] + (event.key === 'ArrowRight' ? 10 : -10), measured);
        },
        fitColumn(columnId) {
            const fittedWidth = autoWidths()[columnId];
            if (fittedWidth === undefined) return;
            setPreference(current => ({
                widths: { ...current.widths, [columnId]: fittedWidth },
                customized: current.customized.filter(id => id !== columnId),
            }));
        },
    }), [columnSignature, preference.widths]);

    const fittedWidth = (column: Column) => preference.widths[column.id] ?? column.defaultWidth;
    const fittedTotal = columns.reduce((total, column) => total + fittedWidth(column), 0);
    const fillColumn = columns.find(column => column.fillRemaining && !preference.customized.includes(column.id));
    const remainingWidth = fillColumn ? Math.max(0, availableWidth - fittedTotal) : 0;
    const columnWidth = (column: Column) => fittedWidth(column) + (column.id === fillColumn?.id ? remainingWidth : 0);
    const totalWidth = fittedTotal + remainingWidth;
    return <ResizeContext.Provider value={context}>
        <table ref={table} {...props} className={`resizable-table ${className}`.trim()}
            style={{ ...props.style, width: totalWidth, minWidth: totalWidth, tableLayout: 'fixed' }}>
            <colgroup>{columns.map(column => <col key={column.id} style={{ width: columnWidth(column) } as CSSProperties} />)}</colgroup>
            {children}
        </table>
    </ResizeContext.Provider>;
}

export function ResizableHeader({ columnId, children, ...props }: ThHTMLAttributes<HTMLTableCellElement> & {
    columnId: string;
    children: ReactNode;
}) {
    const context = useContext(ResizeContext);
    if (!context) throw new Error('ResizableHeader must be inside ResizableTable.');
    const column = context.columns.find(item => item.id === columnId);
    const label = column?.label ?? columnId;
    return <th {...props} data-resizable-column={columnId}>
        {children}<span className="column-resize-handle" role="separator" aria-label={`Resize ${label} column`}
            aria-orientation="vertical" tabIndex={0} title="Drag to resize. Double-click to fit contents."
            onPointerDown={event => context.startResize(columnId, event)}
            onPointerMove={context.continueResize} onPointerUp={context.finishResize} onPointerCancel={context.finishResize}
            onKeyDown={event => context.resizeWithKeyboard(columnId, event)} onDoubleClick={() => context.fitColumn(columnId)} />
    </th>;
}
