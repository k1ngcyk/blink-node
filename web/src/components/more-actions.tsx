"use client";
import { DropdownMenu } from "radix-ui";
import { IconDots } from "@tabler/icons-react";
import { Button } from "./ui/button";

export function MoreActions({
  label,
  disabled,
  items,
}: {
  label: string;
  disabled?: boolean;
  items: { label: string; onSelect: () => void; destructive?: boolean }[];
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" disabled={disabled} aria-label={label}>
          <IconDots size={18} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="action-menu"
          align="end"
          sideOffset={6}
          collisionPadding={12}
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              className={`action-menu-item ${item.destructive ? "error-text" : ""}`}
              onSelect={item.onSelect}
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
