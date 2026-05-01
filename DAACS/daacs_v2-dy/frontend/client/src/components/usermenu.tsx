import { useAuth } from "@/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { LogOut, User as UserIcon, Settings } from "lucide-react";

export function UserMenu() {
  const { user, isAuthenticated, logout } = useAuth(); // Added logout destructuring

  if (!isAuthenticated || !user) {
    return (
      <Button
        variant="default"
        onClick={() => (window.location.href = "/login")} // Updated to simpler path if logical, or keep api/login
        data-testid="button-login"
      >
        로그인
      </Button>
    );
  }

  // Simple initials from username
  const initials = user.username.substring(0, 2).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="relative h-9 w-9 rounded-full" data-testid="button-user-menu">
          <Avatar className="h-9 w-9">
            <AvatarFallback className="bg-primary text-primary-foreground text-sm font-medium">
              {initials}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end" forceMount>
        <div className="flex items-center gap-2 p-2">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-primary text-primary-foreground text-xs">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">
              {user.username}
            </p>
            <p className="text-xs leading-none text-muted-foreground">
              User ID: {user.id}
            </p>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="menu-item-profile">
          <UserIcon className="mr-2 h-4 w-4" />
          <span>프로필</span>
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="menu-item-settings">
          <Settings className="mr-2 h-4 w-4" />
          <span>설정</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => logout()} // Use hook's logout
          data-testid="menu-item-logout"
        >
          <LogOut className="mr-2 h-4 w-4" />
          <span>로그아웃</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
