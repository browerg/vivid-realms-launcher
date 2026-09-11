// Shared formatting keeps the preview and the Discord payload identical.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.discordChangelog = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const LIMIT = 4096;
  const LINK = "https://github.com/browerg/dnd-vtt/blob/rwby-theme/CHANGELOG.md";

  function draft(release, indices) {
    if (!release || !Array.isArray(release.groups) || !Array.isArray(indices) || !indices.length) {
      throw new Error("Choose at least one section to share.");
    }
    const groups = [...new Set(indices)].map((index) => {
      if (!Number.isInteger(index) || !release.groups[index]) throw new Error("Choose valid changelog sections.");
      return release.groups[index];
    });
    return {
      title: `What's New · ${release.heading}`,
      description: groups.map((group) => [group.name ? `**${group.name}**` : "", ...group.items.map((item) => `• ${item}`)].filter(Boolean).join("\n")).join("\n\n"),
    };
  }

  function payload(value) {
    if (typeof value?.title !== "string" || !value.title.trim() || value.title.length > 256) throw new Error("The post title must be between 1 and 256 characters.");
    if (typeof value?.description !== "string" || !value.description.trim()) throw new Error("Choose at least one section to share.");
    if (value.description.length > LIMIT) throw new Error("This post is too long. Choose fewer sections; nothing will be cut off.");
    return {
      username: "Vivid Realms",
      allowed_mentions: { parse: [] },
      embeds: [{ title: value.title, description: value.description, url: LINK, color: 0xc7a15a,
        footer: { text: "Vivid Realms · Click the title for the full changelog" } }],
    };
  }

  return { LIMIT, LINK, draft, payload };
});
