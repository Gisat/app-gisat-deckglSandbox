// src/App.jsx
import React from 'react';
import { BrowserRouter as Router, Route, Link, Routes } from 'react-router-dom';
import mapApps from './maps/config';
import './App.css'; // Import the CSS file for styling

function App() {
    return (
        <Router>
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
        </Router>
    );
}

export default App;
