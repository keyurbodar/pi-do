import React from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import App from './App';
import BloubDemo from './components/roster/BloubDemo';

const el = document.getElementById('root');
if (!el) throw new Error('#root element missing');

if (location.search.includes('bloub-demo=1')) {
  createRoot(el).render(<BloubDemo />);
} else {
  createRoot(el).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
