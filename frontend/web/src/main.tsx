import React from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import App from './App';

const el = document.getElementById('root');
if (!el) throw new Error('#root element missing');

createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
