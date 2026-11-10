export function operatingSystem(os?: string) {
  if (!os?.trim()) return "pending";
  const value = os.toLowerCase();
  if (value.includes("ubuntu")) return "ubuntu";
  if (value.includes("debian")) return "debian";
  if (value.includes("alpine")) return "alpine";
  if (value.includes("rocky")) return "rocky";
  if (value.includes("fedora")) return "fedora";
  if (value.includes("centos")) return "centos";
  if (/red hat|redhat|rhel/.test(value)) return "redhat";
  if (/\barch\b|archlinux/.test(value)) return "arch";
  if (/macos|mac os|darwin/.test(value)) return "macos";
  if (value.includes("windows")) return "windows";
  return "generic";
}
