import { SectionHomeLink } from "./SectionHomeLink";

export function TrackerHomeLink({ className = "" }: { className?: string }) {
  return <SectionHomeLink to="/tasks" label="Трекер" className={className} />;
}
