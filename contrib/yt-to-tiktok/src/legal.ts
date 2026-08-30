import type { Config } from "./config.js";

/**
 * Terms of Service and Privacy Policy pages, served publicly from the same
 * origin as the OAuth callback.
 *
 * TikTok requires both to be reachable before an app can add products or be
 * submitted for audit. They are generated rather than hand-written files so
 * they cannot drift from the identity in config, and so the description of
 * what the software does stays next to the software.
 *
 * These describe THIS system's actual behaviour. They are not legal advice -
 * read them before publishing and adjust anything that does not match how you
 * run it.
 */

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

function contactLine(cfg: Config): string {
  return cfg.LEGAL_CONTACT_EMAIL
    ? `<a href="mailto:${esc(cfg.LEGAL_CONTACT_EMAIL)}">${esc(cfg.LEGAL_CONTACT_EMAIL)}</a>`
    : "<em>[set LEGAL_CONTACT_EMAIL]</em>";
}

function effectiveDate(cfg: Config): string {
  return esc(cfg.LEGAL_EFFECTIVE_DATE ?? new Date().toISOString().slice(0, 10));
}

const STYLE = `
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem;
    color: #1a1a1a; background: #fff;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e8e8; background: #16181c; }
    a { color: #7ab7ff; }
    code { background: #262a31; }
    hr { border-color: #333; }
  }
  h1 { font-size: 1.7rem; margin-bottom: .25rem; }
  h2 { font-size: 1.15rem; margin-top: 2.25rem; }
  .meta { color: #666; font-size: .9rem; margin-top: 0; }
  @media (prefers-color-scheme: dark) { .meta { color: #999; } }
  code { background: #f2f3f5; padding: .1rem .3rem; border-radius: .2rem; font-size: .9em; }
  ul { padding-left: 1.25rem; }
  li { margin: .35rem 0; }
  hr { border: 0; border-top: 1px solid #e5e5e5; margin: 2.5rem 0 1.25rem; }
  footer { color: #666; font-size: .85rem; }
  @media (prefers-color-scheme: dark) { footer { color: #999; } }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head><body>
${body}
</body></html>`;
}

export function renderTerms(cfg: Config): string {
  const who = esc(cfg.LEGAL_ENTITY_NAME);
  return page(
    "Terms of Service",
    `<h1>Terms of Service</h1>
<p class="meta">Effective ${effectiveDate(cfg)}</p>

<p>This service is a private, self-hosted tool operated by ${who} (&ldquo;the
operator&rdquo;). It reformats videos the operator publishes on their own YouTube
channel and posts them to the operator&rsquo;s own TikTok account.</p>

<h2>1. Who may use it</h2>
<p>This is single-operator software. It is not offered to the public, has no user
accounts, and accepts no sign-ups. The only person who can authorise it is the
operator, by completing the TikTok OAuth flow with their own credentials.</p>

<h2>2. What it does</h2>
<ul>
  <li>Watches one YouTube channel, nominated by the operator, for new uploads.</li>
  <li>Reads public metadata for those uploads through the YouTube Data API.</li>
  <li>Reformats video files the operator supplies from their own storage &mdash;
      changing aspect ratio, normalising loudness, and optionally splitting a
      long video into shorter segments.</li>
  <li>Uploads the result to the operator&rsquo;s TikTok account through TikTok&rsquo;s
      official Content Posting API.</li>
</ul>
<p>It does not download video from YouTube, and it does not process content
belonging to anyone other than the operator.</p>

<h2>3. The operator&rsquo;s responsibilities</h2>
<ul>
  <li>Posting only content they own or are licensed to publish.</li>
  <li>Complying with the
      <a href="https://www.tiktok.com/legal/terms-of-service">TikTok Terms of Service</a>,
      TikTok&rsquo;s Community Guidelines, and the
      <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>.</li>
  <li>Disclosing branded or commercial content where TikTok requires it.</li>
  <li>Keeping their own credentials and the machine running this software secure.</li>
</ul>

<h2>4. No warranty</h2>
<p>The software is provided &ldquo;as is&rdquo;, without warranty of any kind, express or
implied. It may fail to detect an upload, fail to encode, or fail to publish.
The operator is responsible for checking that posts appear as intended.</p>

<h2>5. Limitation of liability</h2>
<p>To the maximum extent permitted by law, the operator accepts no liability for
indirect or consequential loss arising from use of this software, including lost
reach, removed posts, or suspended accounts.</p>

<h2>6. Ending access</h2>
<p>The operator may revoke this application&rsquo;s access at any time from TikTok&rsquo;s
account settings, or by deleting the stored credentials. Access ends immediately
and no further posts are made.</p>

<h2>7. Changes</h2>
<p>These terms may be updated as the software changes. The effective date above
records the current version.</p>

<h2>8. Contact</h2>
<p>${contactLine(cfg)}</p>

<hr>
<footer><a href="/legal/privacy">Privacy Policy</a></footer>`
  );
}

export function renderPrivacy(cfg: Config): string {
  const who = esc(cfg.LEGAL_ENTITY_NAME);
  return page(
    "Privacy Policy",
    `<h1>Privacy Policy</h1>
<p class="meta">Effective ${effectiveDate(cfg)}</p>

<p>This service is a private, self-hosted tool operated by ${who}. It has no
users other than the operator, collects nothing from visitors, and shares no
data with anyone beyond the two APIs it is built on.</p>

<h2>1. What it handles</h2>
<ul>
  <li><strong>YouTube video metadata.</strong> Title, description, tags, duration,
      publish time and privacy status for uploads on the operator&rsquo;s own channel,
      read through the YouTube Data API. This is information already public on
      the channel.</li>
  <li><strong>TikTok credentials.</strong> An OAuth access token, refresh token,
      the account&rsquo;s <code>open_id</code>, and the granted scopes.</li>
  <li><strong>TikTok account limits.</strong> Username, display name, available
      privacy levels and maximum post duration, read before each post so the
      upload respects the account&rsquo;s own settings.</li>
  <li><strong>Video files.</strong> Master files the operator supplies, and the
      reformatted copies made from them.</li>
  <li><strong>Job records.</strong> Which video was processed, when, its state,
      and any error.</li>
</ul>

<h2>2. What it does not do</h2>
<ul>
  <li>No analytics, tracking pixels, cookies, or advertising.</li>
  <li>No data sold, rented, or shared for marketing.</li>
  <li>No processing of anyone else&rsquo;s personal data &mdash; there are no end users.</li>
  <li>No collection of TikTok viewer or follower information.</li>
</ul>

<h2>3. Where data goes</h2>
<p>Two destinations only, both necessary for the service to function:</p>
<ul>
  <li><strong>Google</strong> &mdash; YouTube Data API requests for the operator&rsquo;s
      own channel metadata.</li>
  <li><strong>TikTok</strong> &mdash; authentication, and uploading the operator&rsquo;s
      video to the operator&rsquo;s own account.</li>
</ul>
<p>There are no other third parties. No hosted analytics, error-reporting, or
storage services are used.</p>

<h2>4. Where data is stored</h2>
<p>On the machine the operator runs the software on. Credentials and job records
live in a local SQLite database; video files live on the local filesystem.
Nothing is stored on infrastructure controlled by anyone else. The operator is
responsible for protecting that machine and restricting access to the data
directory.</p>

<h2>5. How long it is kept</h2>
<ul>
  <li>Reformatted video files are deleted once TikTok confirms the post.</li>
  <li>Master files are never modified or deleted by this software.</li>
  <li>Credentials are kept until they expire or the operator deletes them.</li>
  <li>Job records are kept until the operator deletes the database.</li>
</ul>

<h2>6. Control and deletion</h2>
<p>The operator can revoke this application&rsquo;s access from TikTok&rsquo;s account
settings at any time, which invalidates the stored tokens. Deleting the local
data directory removes every record the software holds.</p>

<h2>7. Children</h2>
<p>This is an operator-only tool with no public interface and is not directed at
children.</p>

<h2>8. Changes</h2>
<p>This policy may be updated as the software changes. The effective date above
records the current version.</p>

<h2>9. Contact</h2>
<p>${contactLine(cfg)}</p>

<hr>
<footer><a href="/legal/terms">Terms of Service</a></footer>`
  );
}
