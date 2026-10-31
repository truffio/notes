import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { ApiError, api } from '../api.ts';
import { FeedPage } from '../feed/FeedPage.tsx';
import { ListsPage } from '../lists/ListsPage.tsx';
import { TagsPage } from '../tags/TagsPage.tsx';

type Auth = 'loading' | 'in' | 'out';
type View = 'feed' | 'tags' | 'lists';

interface Route {
  view: View;
  tag?: string;
}

function readRoute(): Route {
  const { pathname, search } = window.location;
  if (pathname.startsWith('/tags')) return { view: 'tags' };
  if (pathname.startsWith('/lists')) return { view: 'lists' };
  const tag = new URLSearchParams(search).get('tag');
  return tag ? { view: 'feed', tag } : { view: 'feed' };
}

/** Exchanges a `#token=` on `/login` for a session, then removes it from the URL. */
async function loginFromUrl(): Promise<void> {
  if (window.location.pathname !== '/login') return;
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  window.history.replaceState(null, '', '/');
  if (token) await api.login(token);
}

const NAV: { view: View; path: string; label: string }[] = [
  { view: 'feed', path: '/', label: 'Notes' },
  { view: 'tags', path: '/tags', label: 'Tags' },
  { view: 'lists', path: '/lists', label: 'Lists' },
];

export function App() {
  const [auth, setAuth] = useState<Auth>('loading');
  const [bootError, setBootError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(readRoute);
  const started = useRef(false);

  useEffect(() => {
    // Login tokens are single use, so boot only once even under StrictMode.
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        await loginFromUrl();
        await api.me();
        setAuth('in');
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401) setBootError(e instanceof Error ? e.message : 'Failed to load');
        setAuth('out');
      }
    })();
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    setRoute(readRoute());
  }, []);

  const onNavClick = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(path);
  };

  if (auth === 'loading') {
    return (
      <main className="shell">
        <p className="muted">Loading...</p>
      </main>
    );
  }

  if (auth === 'out') {
    return (
      <main className="shell">
        <div className="card signed-out">
          <h1>Signed out</h1>
          <p>Send <code>/login</code> to the bot to get a sign-in link.</p>
          {bootError ? <p role="alert" className="error">{bootError}</p> : null}
        </div>
      </main>
    );
  }

  return (
    <>
      <header className="topbar">
        <nav aria-label="Main">
          {NAV.map((item) => (
            <a
              key={item.view}
              href={item.path}
              aria-current={route.view === item.view ? 'page' : undefined}
              onClick={(e) => onNavClick(e, item.path)}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </header>
      <main className="shell">
        {route.view === 'feed' ? (
          <FeedPage tag={route.tag} onClearTag={() => navigate('/')} />
        ) : route.view === 'tags' ? (
          <TagsPage onSelectTag={(name) => navigate(`/?tag=${encodeURIComponent(name)}`)} />
        ) : (
          <ListsPage />
        )}
      </main>
    </>
  );
}
