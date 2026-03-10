interface AttachmentChipProps {
  path: string;
  onRemove: (path: string) => void;
}

export function AttachmentChip({ path, onRemove }: AttachmentChipProps) {
  const parts = path.split("/");
  const name = parts.pop()!;

  return (
    <span class="attachment-chip" title={path}>
      <i class="codicon codicon-file" />
      <span class="attachment-chip-name">{name}</span>
      <button
        class="attachment-chip-remove"
        onClick={() => onRemove(path)}
        title="Remove"
        type="button"
      >
        <i class="codicon codicon-close" />
      </button>
    </span>
  );
}

interface ImageAttachmentChipProps {
  id: string;
  name: string;
  dataUrl: string;
  onRemove: (id: string) => void;
}

export function ImageAttachmentChip({
  id,
  name,
  dataUrl,
  onRemove,
}: ImageAttachmentChipProps) {
  return (
    <span class="attachment-chip image-attachment-chip" title={name}>
      <img class="attachment-chip-thumbnail" src={dataUrl} alt={name} />
      <span class="attachment-chip-name">{name}</span>
      <button
        class="attachment-chip-remove"
        onClick={() => onRemove(id)}
        title="Remove"
        type="button"
      >
        <i class="codicon codicon-close" />
      </button>
    </span>
  );
}

interface DocumentAttachmentChipProps {
  id: string;
  name: string;
  onRemove: (id: string) => void;
}

export function DocumentAttachmentChip({
  id,
  name,
  onRemove,
}: DocumentAttachmentChipProps) {
  return (
    <span class="attachment-chip document-attachment-chip" title={name}>
      <i class="codicon codicon-file-pdf" />
      <span class="attachment-chip-name">{name}</span>
      <button
        class="attachment-chip-remove"
        onClick={() => onRemove(id)}
        title="Remove"
        type="button"
      >
        <i class="codicon codicon-close" />
      </button>
    </span>
  );
}
