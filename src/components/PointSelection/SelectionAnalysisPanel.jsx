import { useEffect, useRef, useState } from 'react';
import { SelectionControls } from './SelectionControls';
import { DrawingOverlay } from './DrawingOverlay';
import { TimeSeriesChart } from './TimeSeriesChart';
import { LineProfileChart } from '../2DLineProfile';

import { normalizeGeometry } from './geometryUtils';

export function SelectionAnalysisPanel({
    // State and callbacks from parent
    selectionMode,
    onSelectionModeChange,
    isDrawing,
    onIsDrawingChange,
    bufferDistance,
    onBufferDistanceChange,
    onClear,
    onGeometryComplete,

    // Data to display, provided by parent
    selectedCount,
    selectedFeatures,
    profileData,
    isLoading, // For loading indicators
    backendFeatureCount,
    
    // Configuration
    lineProfileMetrics,
    is3D,
    viewState,
    onPointHover, // Optional callback for hover events

    // Positioning
    top,
    left,

    // Optional content rendered directly under the selection card. The card's
    // height changes with the drawing mode / selection state, so it is measured
    // instead of assuming a fixed offset.
    belowSelectionPanel,
}) {
    const [showLineProfileChart, setShowLineProfileChart] = useState(false);

    const selectionCardRef = useRef(null);
    const [selectionCardHeight, setSelectionCardHeight] = useState(null);

    useEffect(() => {
        const element = selectionCardRef.current;
        if (!element) return undefined;

        const updateHeight = () => setSelectionCardHeight(element.offsetHeight);
        updateHeight();

        if (typeof ResizeObserver === 'undefined') return undefined;

        const observer = new ResizeObserver(updateHeight);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const handleClear = () => {
        setShowLineProfileChart(false);
        if (onClear) {
            onClear();
        }
    }

    const handleModeChange = (newMode) => {
        if (selectionMode === newMode) {
            onSelectionModeChange(null);
            onIsDrawingChange(false);
        } else {
            onSelectionModeChange(newMode);
            onIsDrawingChange(true);
        }
    }

    const handleGeometryCompleteInternal = (mode, coords, buffer) => {
        // Coords can be an array of [lon, lat] or an array of {geo: [lon, lat], ...} for 3D.
        // Extract the numerical coordinates before passing to turf/normalize functions.
        const geoCoords = coords.map(c => (Array.isArray(c) ? c : c.geo));
        const geometry = normalizeGeometry(mode, geoCoords, buffer);
        
        if (onGeometryComplete) {
            // Pass the original geometry AND the original coords back up
            onGeometryComplete(geometry, mode, coords);
        }
    };

    // Hide line profile option if no metrics are provided
    const showLineProfileOption = lineProfileMetrics && lineProfileMetrics.length > 0;

    return (
        <>
            <SelectionControls
                selectionMode={selectionMode}
                onModeChange={handleModeChange}
                bufferDistance={bufferDistance}
                onBufferChange={onBufferDistanceChange}
                selectedCount={selectedCount}
                onClear={handleClear}
                showLineProfileChart={showLineProfileChart && showLineProfileOption}
                onShowLineProfileChartChange={setShowLineProfileChart}
                isLoadingBackend={isLoading}
                backendFeatureCount={backendFeatureCount}
                top={top}
                left={left}
                containerRef={selectionCardRef}
            />

            {belowSelectionPanel && selectionCardHeight != null && (
                <div style={{
                    position: 'absolute',
                    top: `calc(${top || '130px'} + ${selectionCardHeight}px + 8px)`,
                    left: left || '10px',
                    zIndex: 999,
                }}>
                    {belowSelectionPanel}
                </div>
            )}

            <DrawingOverlay
                viewState={viewState}
                selectionMode={selectionMode}
                isDrawing={isDrawing}
                onGeometryComplete={handleGeometryCompleteInternal}
                bufferDistance={bufferDistance}
                is3D={is3D}
            />

            <div style={{
                position: 'absolute',
                bottom: '10px',
                left: '10px',
                width: 'calc(50% - 280px)',
                minWidth: '300px',
                zIndex: 999,
            }}>
                {selectionMode === 'line' && showLineProfileChart && profileData ? (
                    <LineProfileChart
                        data={profileData}
                        title="Line Profile"
                        onPointHover={onPointHover}
                    />
                ) : selectedFeatures ? (
                    <TimeSeriesChart
                        selectedFeatures={selectedFeatures}
                        isLoading={isLoading}
                        onPointHover={onPointHover}
                    />
                ) : null}
            </div>
        </>
    );
}
