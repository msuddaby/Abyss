// Storage + API base must be initialized before any @abyss/shared store is used.
import './storage';
import { createRoot } from 'react-dom/client';
import '../index.css';
import '../App.css';
import './widget.css';
import WidgetApp from './WidgetApp';

// No StrictMode: the bootstrap effect performs a one-shot token exchange +
// SignalR connect, and we don't want it double-invoked in dev.
createRoot(document.getElementById('root')!).render(<WidgetApp />);
