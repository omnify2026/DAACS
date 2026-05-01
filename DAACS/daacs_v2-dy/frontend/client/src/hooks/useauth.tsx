import { createContext, useContext, useState, ReactNode } from "react";
import { useLocation } from "wouter";

interface User {
    id: number;
    username: string;
}

interface AuthContextType {
    user: User | null;
    isLoading: boolean;
    isAuthenticated: boolean;
    login: (username: string, password: string) => boolean;
    logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(() => {
        const storedUser = localStorage.getItem("daacs_user");
        if (!storedUser) {
            return null;
        }
        try {
            return JSON.parse(storedUser) as User;
        } catch {
            localStorage.removeItem("daacs_user");
            return null;
        }
    });
    const [isLoading] = useState(false);
    const [, setLocation] = useLocation();

    const login = (username: string, password: string): boolean => {
        if (username === "admin" && password === "admin") {
            const newUser = { id: 1, username };
            localStorage.setItem("daacs_user", JSON.stringify(newUser));
            setUser(newUser);
            return true;
        }
        return false;
    };

    const logout = () => {
        localStorage.removeItem("daacs_user");
        localStorage.removeItem("daacs_draft_project_id");
        setUser(null);
        setLocation("/");
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                isLoading,
                isAuthenticated: !!user,
                login,
                logout,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
