import { faApple, faLinux, faWindows } from "@fortawesome/free-brands-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Monitor } from "lucide-react";

type HostPlatformIconProps = {
  environment?: string | null | undefined;
  platform?: string | null | undefined;
  osName?: string | null | undefined;
  size?: number;
};

export function HostPlatformIcon({ environment, platform, osName, size = 16 }: HostPlatformIconProps) {
  const identity = `${environment ?? ""} ${platform ?? ""} ${osName ?? ""}`.toLowerCase();
  if (identity.includes("darwin") || identity.includes("macos") || identity.includes("mac os")) return <FontAwesomeIcon icon={faApple} style={{ width: size, height: size }} aria-hidden="true" />;
  if (identity.includes("windows")) return <FontAwesomeIcon icon={faWindows} style={{ width: size, height: size }} aria-hidden="true" />;
  if (identity.includes("linux") || identity.includes("unix")) return <FontAwesomeIcon icon={faLinux} style={{ width: size, height: size }} aria-hidden="true" />;
  return <Monitor size={size} aria-hidden="true" />;
}
