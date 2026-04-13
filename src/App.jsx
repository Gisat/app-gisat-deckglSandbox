// src/App.jsx
import React, { useState } from 'react';
import { BrowserRouter, Route, Link, Routes, useLocation } from 'react-router-dom';
import mapApps from './maps/config';
import './App.css'; // Import the CSS file for styling

function AppContent() {
    const location = useLocation();
    const [expandedGroups, setExpandedGroups] = useState({
        '3DFLUS CCN': true,
        '3DFLUS': false,
        'GeoParquet': false,
        'Other': false,
    });

    const toggleGroup = (category) => {
        setExpandedGroups(prev => ({
            ...prev,
            [category]: !prev[category]
        }));
    };
    
    // Group maps by category
    const groupedMaps = mapApps.reduce((acc, app) => {
        const category = app.category || 'Other';
        if (!acc[category]) acc[category] = [];
        acc[category].push(app);
        return acc;
    }, {});

    // Define group order
    const groupOrder = ['3DFLUS CCN', '3DFLUS', 'GeoParquet', 'Other'];
    const sortedGroups = groupOrder.filter(g => g in groupedMaps);

    return (
        <div className="app-container">
            <nav className="sidebar">
                <h1>Sandbox</h1>
                {sortedGroups.map((category) => (
                    <div key={category} className="map-group">
                        <button 
                            className="group-title-btn" 
                            onClick={() => toggleGroup(category)}
                        >
                            <span className="group-chevron">{expandedGroups[category] ? '▼' : '▶'}</span>
                            <span className="group-title-text">{category}</span>
                        </button>
                        {expandedGroups[category] && (
                            <ul>
                                {groupedMaps[category].map((app) => (
                                    <li key={app.path} className={location.pathname === app.path ? 'active' : ''}>
                                        <Link to={app.path}>{app.name}</Link>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                ))}
            </nav>
            <main className="main-content">
                <Routes>
                    {mapApps.map((app) => (
                        <Route key={app.path} path={app.path} element={<app.component />} />
                    ))}
                </Routes>
            </main>
        </div>
    );
}

function App() {
    const basename = import.meta.env.MODE === 'production' ? '/app-gisat-deckglSandbox/' : '/';
    
    return (
        <BrowserRouter basename={basename} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <AppContent />
        </BrowserRouter>
    );
}

export default App;
