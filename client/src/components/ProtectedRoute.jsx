import { Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth.jsx";

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="grid h-full place-items-center text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}
