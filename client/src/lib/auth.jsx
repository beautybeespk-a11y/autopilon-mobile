import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api.js";

const AuthContext = createContext();
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/auth/me").then((d) => setUser(d.user)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const d = await api.post("/auth/login", { email, password });
    setUser(d.user);
  };
  const signup = async (name, email, password) => {
    const d = await api.post("/auth/signup", { name, email, password });
    setUser(d.user);
  };
  const logout = async () => {
    await api.post("/auth/logout");
    setUser(null);
  };
  // The server already destroys the session as part of DELETE /auth/me —
  // this just clears the client's own copy of it, same as logout().
  const deleteAccount = async () => {
    await api.del("/auth/me");
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout, deleteAccount }}>
      {children}
    </AuthContext.Provider>
  );
}
