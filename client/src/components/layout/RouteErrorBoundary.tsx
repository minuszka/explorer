import { Component, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { HiOutlineArrowPath, HiOutlineHome } from 'react-icons/hi2';
import StatePanel from '../ui/StatePanel';
import { reloadAfterChunkFailure } from '../../utils/releaseReload';

interface RouteErrorBoundaryProps {
  /** Navigating to a different value clears the failure and renders the new route. */
  resetKey: string;
  children: ReactNode;
}

interface RouteErrorBoundaryState {
  failed: boolean;
  reloading: boolean;
}

export function ReloadPageButton() {
  return (
    <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
      <HiOutlineArrowPath /> Reload page
    </button>
  );
}

/** Keeps the header and footer on screen when a page fails, instead of a blank document. */
export default class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = { failed: false, reloading: false };

  static getDerivedStateFromError(): Partial<RouteErrorBoundaryState> {
    return { failed: true };
  }

  componentDidCatch() {
    if (reloadAfterChunkFailure()) this.setState({ reloading: true });
  }

  componentDidUpdate(previous: RouteErrorBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false, reloading: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.state.reloading) {
      return <div role="status"><StatePanel title="Loading the latest version..." /></div>;
    }
    return (
      <div role="alert" className="fade-in">
        <StatePanel
          tone="danger"
          title="This page could not be loaded"
          description="The site may have been updated since this tab was opened, or the connection dropped."
          action={
            <div className="cluster state-panel-actions">
              <ReloadPageButton />
              <Link to="/" className="btn btn-secondary">
                <HiOutlineHome /> Go Home
              </Link>
            </div>
          }
        />
      </div>
    );
  }
}
