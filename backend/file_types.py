"""Allowed file types; no imports, so offline scripts can use it without the app."""

TYPES = {
    "image/png": ("png",),
    "image/jpeg": ("jpg", "jpeg"),
    "image/webp": ("webp",),
    "application/pdf": ("pdf",),
    "application/zip": ("zip",),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (
        "docx",
    ),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ("xlsx",),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": (
        "pptx",
    ),
    "application/msword": ("doc",),
    "application/vnd.ms-excel": ("xls",),
    "application/vnd.ms-powerpoint": ("ppt",),
    "text/plain": ("txt", "md", "py", "js", "jsx", "ts", "tsx", "json", "yaml", "yml", "toml", "ini", "cfg", "log", "sh", "zsh", "c", "h", "cpp", "hpp", "java", "rs", "go", "sql", "r", "css"),
}


def mime_for(name):
    """The type of an allowed extension, or None."""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return next((m for m, extensions in TYPES.items() if ext in extensions), None)
