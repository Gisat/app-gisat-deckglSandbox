import { useState } from 'react';
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
}) {
    const [showLineProfileChart, setShowLineProfileChart] = useState(false);

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
            />

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
