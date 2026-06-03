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
            position: 'absolute', bottom: 10, left: 'max(10px, calc(50% - 400px))', transform: 'translateX(0)',
            width: '60%', maxWidth: '400px', background: 'rgba(255, 255, 255, 0.95)', padding: '11px',
            borderRadius: '8px', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)', fontFamily: 'system-ui, sans-serif', fontSize: '13px', color: '#333', zIndex: 1000
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <div style={{ fontWeight: 'bold' }}>
                    {date || 'Loading...'}
                    {isLoading && <span style={{ color: 'orange', marginLeft: '10px', fontSize: '0.8em' }}> Fetching...</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                    {/* MODE TOGGLE */}
                    <div style={{ display: 'flex', background: '#e0e0e0', borderRadius: '20px', padding: '2px', marginRight: '15px' }}>
                        <button
                            onClick={() => setMode('static')}
                            style={{
                                padding: '5px 15px',
                                background: mode === 'static' ? 'white' : 'transparent',
                                color: mode === 'static' ? 'black' : '#666',
                                border: 'none',
                                borderRadius: '18px',
                                boxShadow: mode === 'static' ? '0 1px 3px rgba(0,0,0,0.2)' : 'none',
                                cursor: 'pointer',
                                fontWeight: mode === 'static' ? 'bold' : 'normal',
                                transition: 'all 0.2s'
                            }}
                        >
                            Static
                        </button>
                        <button
                            onClick={() => setMode('animation')}
                            style={{
                                padding: '5px 15px',
                                background: mode === 'animation' ? '#4caf50' : 'transparent',
                                color: mode === 'animation' ? 'white' : '#666',
                                border: 'none',
                                borderRadius: '18px',
                                boxShadow: mode === 'animation' ? '0 1px 3px rgba(0,0,0,0.2)' : 'none',
                                cursor: 'pointer',
                                fontWeight: mode === 'animation' ? 'bold' : 'normal',
                                transition: 'all 0.2s'
                            }}
                        >
                            Animation
                        </button>
                    </div>
                    <button
                        onClick={() => setIsPlaying(!isPlaying)}
                        disabled={mode === 'static' || isLoading}
                        style={{
                            padding: '5px 15px',
                            background: isPlaying ? '#ff5252' : '#2196f3',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            opacity: (mode === 'static' || isLoading) ? 0.5 : 1,
                            cursor: (mode === 'static' || isLoading) ? 'not-allowed' : 'pointer'
                        }}
                    >
                        {isPlaying ? 'Pause' : 'Play'}
                    </button>
                </div>
            </div>
            <input type="range" min={0} max={totalDates > 0 ? totalDates - 1 : 0} value={timeIndex} onChange={e => { setIsPlaying(false); setTimeIndex(Number(e.target.value)); }} style={{ width: '100%' }} disabled={totalDates === 0} />
        </div>
    );
};
