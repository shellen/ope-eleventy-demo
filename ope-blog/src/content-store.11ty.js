const siteUrl = process.env.URL || "https://ope-demo.netlify.app";
const publisherName = "OPE Demo Blog";

export const data = {
  permalink: "api/content/_store.json",
  eleventyExcludeFromCollections: true,
};

export function render(data) {
  const posts = (data.collections && data.collections.post) || [];
  const store = {};

  for (const post of posts) {
    if (post.data && post.data.ope_gated) {
      const id = post.data.ope_content_id || post.fileSlug;
      store[id] = {
        id,
        title: post.data.title || "",
        resource_type: post.data.ope_resource_type || "article",
        content_html: post.content || "",
        published: post.date ? post.date.toISOString() : new Date().toISOString(),
        author: { name: publisherName, url: siteUrl },
      };
    }
  }

  return JSON.stringify(store, null, 2);
}
