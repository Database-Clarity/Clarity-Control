import { ReviewSidebar } from '../review/ReviewSidebar';
import '../review/model';

export function ReviewSidebarNavigation() {
  return (
    <nav aria-label="Pending saved changes" style={{ height: '100%', minHeight: 0 }}>
      <ReviewSidebar />
    </nav>
  );
}
