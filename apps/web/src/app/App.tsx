import { FeedPage } from '../feed/FeedPage.tsx';
import { ListsPage } from '../lists/ListsPage.tsx';
import { TagsPage } from '../tags/TagsPage.tsx';

/** Placeholder until F2.2, which owns routing, login and the page shell. */
export function App() {
  return (
    <main>
      <FeedPage />
      <TagsPage />
      <ListsPage />
    </main>
  );
}
