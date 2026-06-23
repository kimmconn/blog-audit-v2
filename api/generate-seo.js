export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { idea, postTitle, postUrl, summary } = req.body;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key not configured' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `You are helping a travel blogger named Kimmie update her post titled "${postTitle}" at ${postUrl}.

Her writing voice: casual first-person, discovery energy, quick humor injections, direct practical advice, no generic filler, no prices.

SEO task: ${idea}

Post context: ${summary || ''}

Generate the requested content (table, FAQ, schema, heading, etc.) ready to copy-paste into WordPress. For tables use simple HTML. For FAQ use H3 headings with paragraph answers in Kimmie's voice. For schema markup provide the JSON-LD script tag. Keep it concise and useful.`
        }]
      }),
      signal: AbortSignal.timeout(30000),
    });

    const data = await response.json();
    const generated = data.content?.[0]?.text || 'Could not generate content.';
    return res.status(200).json({ generated });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
