/**
 * Row splitting shared by the 2D and 3D Arrow LOD stream maps.
 *
 * Arrow mode splits each tile into small-displacement points (circles) and
 * moving points (arrows) using the CURRENT displayed displacement, so the
 * symbols change with the timeline. The split is cached per table; pan/zoom
 * reuse it and unchanged classifications are reused across dates so the layers
 * keep a stable `data` identity (positions are not re-uploaded every frame).
 *
 * `tableData.arrowTable` is the raw Arrow table, which is stable across
 * re-renders (the wrapper object is rebuilt by `_processArrowTables`).
 */

import { isSmallDisplacement } from './velocity/displacementSymbols';

const symbolRowSplitCache = new WeakMap();

/**
 * Cheap order-sensitive hash of the circle/arrow classification, used to detect
 * a date change that leaves every row in the same class.
 *
 * @param {object} tableData - Processed Arrow table wrapper.
 * @param {string} mode - `'static'` or `'animation'`.
 * @param {number} timeIndex - Displayed date index.
 * @returns {string} Signature `"<circleCount>:<hash>"`.
 */
function computeSplitSignature(tableData, mode, timeIndex) {
    let hash = 2166136261;
    let circleCount = 0;
    for (let i = 0; i < tableData.numRows; i++) {
        if (isSmallDisplacement(tableData.getDisplacementValue(i, mode, timeIndex))) {
            hash = Math.imul(hash ^ i, 16777619);
            circleCount += 1;
        }
    }
    return `${circleCount}:${hash >>> 0}`;
}

/**
 * Splits the table's row indices into arrow and circle rows for the displayed
 * date, reusing the previous result when the classification is unchanged.
 *
 * @param {object} tableData - Processed Arrow table wrapper.
 * @param {string} mode - `'static'` or `'animation'`.
 * @param {number} timeIndex - Displayed date index.
 * @returns {{key: string, signature: string, arrowRows: number[], circleRows: number[]}}
 */
export function getSymbolRowSplit(tableData, mode, timeIndex) {
    const key = `${mode}:${timeIndex}`;
    const cached = symbolRowSplitCache.get(tableData.arrowTable);
    if (cached && cached.key === key) return cached;

    const signature = computeSplitSignature(tableData, mode, timeIndex);
    if (cached && cached.signature === signature) {
        // Same classification as the previous date: keep the existing row
        // arrays so deck.gl sees the same `data` and skips the position rebuild.
        const reused = { ...cached, key };
        symbolRowSplitCache.set(tableData.arrowTable, reused);
        return reused;
    }

    const arrowRows = [];
    const circleRows = [];
    for (let i = 0; i < tableData.numRows; i++) {
        if (isSmallDisplacement(tableData.getDisplacementValue(i, mode, timeIndex))) {
            circleRows.push(i);
        } else {
            arrowRows.push(i);
        }
    }

    const split = { key, signature, arrowRows, circleRows };
    symbolRowSplitCache.set(tableData.arrowTable, split);
    return split;
}

const allRowIndexCache = new WeakMap();

/**
 * All-row index list for circle mode; cached so pan/zoom reuses the same array.
 *
 * @param {object} tableData - Processed Arrow table wrapper.
 * @returns {number[]} `[0, 1, …, numRows - 1]`.
 */
export function getAllRowIndices(tableData) {
    let rows = allRowIndexCache.get(tableData.arrowTable);
    if (!rows) {
        rows = Array.from({ length: tableData.numRows }, (_, i) => i);
        allRowIndexCache.set(tableData.arrowTable, rows);
    }
    return rows;
}
