import React from 'react';

export const PlaybackControls = ({
    date,
    mode,
    isPlaying,
    isLoading,
    timeIndex,
    totalDates,
    setMode,
    setIsPlaying,
    setTimeIndex
}) => {
    return (
        <div style={{
            position: 'absolute', bottom: 30, left: '50%', transform: 'translateX(-50%)',
            width: '80%', maxWidth: '600px', backgroundColor: 'white', padding: '15px',
            borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', fontFamily: 'sans-serif', zIndex: 10
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <div style={{ fontWeight: 'bold' }}>
                    {date || 'Loading...'}
                    {isLoading && <span style={{ color: 'orange', marginLeft: '10px', fontSize: '0.8em' }}> Fetching...</span>}
                </div>
                <div>
                    <button onClick={() => setMode(m => m === 'static' ? 'animation' : 'static')} style={{ marginRight: '10px', padding: '5px 10px', background: mode === 'animation' ? '#4caf50' : '#e0e0e0', color: mode === 'animation' ? 'white' : 'black', border: 'none', borderRadius: '4px' }}>
                        {mode === 'animation' ? 'Mode: Animation' : 'Mode: Static'}
                    </button>
                    <button onClick={() => setIsPlaying(!isPlaying)} disabled={mode === 'static' || isLoading} style={{ padding: '5px 15px', background: isPlaying ? '#ff5252' : '#2196f3', color: 'white', border: 'none', borderRadius: '4px' }}>
                        {isPlaying ? 'Pause' : 'Play'}
                    </button>
                </div>
            </div>
            <input type="range" min={0} max={totalDates > 0 ? totalDates - 1 : 0} value={timeIndex} onChange={e => { setIsPlaying(false); setTimeIndex(Number(e.target.value)); }} style={{ width: '100%' }} disabled={totalDates === 0} />
        </div>
    );
};
