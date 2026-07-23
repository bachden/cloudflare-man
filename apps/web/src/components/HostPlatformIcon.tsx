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
  const icon = identity.includes("darwin") || identity.includes("macos") || identity.includes("mac os")
    ? <FontAwesomeIcon icon={faApple} />
    : identity.includes("windows")
      ? <FontAwesomeIcon icon={faWindows} />
      : identity.includes("linux") || identity.includes("unix")
        ? <FontAwesomeIcon icon={faLinux} />
        : <Monitor size={size} />;
  return <span className="host-platform-icon" style={{ width: size, height: size }} aria-hidden="true">{icon}</span>;
}
