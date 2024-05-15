// src/App.jsx
import React from 'react';
import { BrowserRouter as Router, Route, Link, Routes } from 'react-router-dom';
import mapApps from './maps/config';

function App() {
    return (
        <Router>
            <div>
                <h1>Map Apps</h1>
                <ul>
                    {mapApps.map((app) => (
                        <li key={app.path}>
                            <Link to={app.path}>{app.name}</Link>
                        </li>
                    ))}
                </ul>
                <Routes>
                    {mapApps.map((app) => (
                        <Route key={app.path} path={app.path} element={<app.component />} />
                    ))}
                </Routes>
            </div>
        </Router>
    );
}

export default App;
