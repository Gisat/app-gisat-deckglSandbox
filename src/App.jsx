// src/App.jsx
import React from 'react';
import { BrowserRouter, Route, Link, Routes } from 'react-router-dom';
import mapApps from './maps/config';
import './App.css'; // Import the CSS file for styling

function App() {
    const basename = import.meta.env.MODE === 'production' ? '/app-gisat-deckglSandbox/' : '/';
    return (
        <BrowserRouter basename={basename} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <div className="app-container">
                <nav className="sidebar">
                    <h1>Map Apps</h1>
                    <ul>
                        {mapApps.map((app) => (
                            <li key={app.path}>
                                <Link to={app.path}>{app.name}</Link>
                            </li>
                        ))}
                    </ul>
                </nav>
                <main className="main-content">
                    <Routes>
                        {mapApps.map((app) => (
                            <Route key={app.path} path={app.path} element={<app.component />} />
                        ))}
                    </Routes>
                </main>
            </div>
        </BrowserRouter>
    );
}

export default App;
