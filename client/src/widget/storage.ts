// MUST be imported before anything that uses @abyss/shared stores/services.
// The shoutbox widget runs embedded in a cross-origin iframe; it uses an
// in-memory storage adapter so its tokens never touch the host page's
// localStorage and never collide with the main Abyss app (which may be open
// in another tab on the same origin). The widget re-exchanges its XenForo
// token on every load, so there is nothing worth persisting across reloads.
import { setStorage, setApiBase } from '@abyss/shared';

const mem = new Map<string, string>();

setStorage({
  getItem: (key) => (mem.has(key) ? mem.get(key)! : null),
  setItem: (key, value) => { mem.set(key, value); },
  removeItem: (key) => { mem.delete(key); },
});

// The widget is served by the Abyss origin, so all API/SignalR calls are
// same-origin via relative paths — no CORS, no configured base URL.
setApiBase('');
