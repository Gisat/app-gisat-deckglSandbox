import React from 'react';

export default function TimeControl({
    currentDate,
    timeIndex,
    maxIndex,
    isPlaying,
    fullVectorsLoaded,
    dataReady,
    onToggleMode,
    onPlayPause,
    onSliderChange
}) {
    const isBuffering = isPlaying && !dataReady;

    return (
        <div className="vtm-time-control">
            <div className="vtm-time-header">
                <div className="vtm-date-display">
                    {currentDate || 'Loading...'}
                </div>
                <button
                    onClick={() => onToggleMode('static')}
                    className={`vtm-button vtm-static-button ${fullVectorsLoaded ? 'active' : 'inactive'}`}
                    disabled={!fullVectorsLoaded}
                >
                    🖼️ Static View
                </button>
                <button
                    onClick={onPlayPause}
                    className={`vtm-button vtm-play-button ${isPlaying ? 'playing' : (fullVectorsLoaded ? 'ready' : 'load')}`}
                    disabled={isBuffering}
                >
                    {isBuffering ? '⏳ Loading...' : (isPlaying ? '⏸ Pause' : (fullVectorsLoaded ? '▶ Play' : '💾 Load All + Play'))}
                </button>
            </div>
            <input
                type="range"
                min={0}
                max={maxIndex}
                value={timeIndex}
                onChange={onSliderChange}
                className="vtm-slider"
                disabled={maxIndex === 0 || isBuffering}
            />
            <div className="vtm-footer-text">
                {fullVectorsLoaded ? 'Animation enabled.' : 'In Lightweight mode, sliding will fetch data for the selected date.'}
            </div>
        </div>
    );
}
