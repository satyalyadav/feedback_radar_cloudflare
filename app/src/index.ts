/**
 * Feedback Radar - Cloudflare Workers App
 * 
 * Features:
 * - Submit feedback via POST /api/feedback
 * - Analyze feedback using Workers AI (sentiment, tags, summary, urgency)
 * - Store in D1 database
 * - Emit Analytics Engine events
 * - Dashboard UI at GET /
 * - Stats API at GET /api/stats
 */

interface FeedbackRow {
	id?: number;
	source: string;
	text: string;
	created_at: number;
	sentiment?: string;
	urgency?: number;
	tags?: string;
	summary?: string;
	ai_model?: string;
	ai_latency_ms?: number;
	analysis_status: string;
	analysis_error?: string;
}

interface AIAnalysis {
	sentiment: 'positive' | 'neutral' | 'negative';
	urgency: number;
	tags: string[];
	summary: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		// CORS headers for API routes
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		if (method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			// Route: Dashboard (GET /)
			if (path === '/' && method === 'GET') {
				// Emit analytics event
				env.ANALYTICS?.writeDataPoint({
					blobs: ['dashboard_view', '/', 'all', 'success'],
					doubles: [1, 0],
					indexes: [new Date().toISOString().split('T')[0]],
				});

				return new Response(getDashboardHTML(), {
					headers: { 'Content-Type': 'text/html' },
				});
			}

			// Route: Submit feedback (POST /api/feedback)
			if (path === '/api/feedback' && method === 'POST') {
				const startTime = Date.now();
				
				// Emit analytics event for ingestion
				env.ANALYTICS?.writeDataPoint({
					blobs: ['ingest_received', '/api/feedback', 'unknown', 'pending'],
					doubles: [1, 0],
					indexes: [new Date().toISOString().split('T')[0]],
				});

				const body = await request.json() as { source: string; text: string };
				const { source, text } = body;

				if (!source || !text) {
					return new Response(
						JSON.stringify({ error: 'Missing required fields: source, text' }),
						{ status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
					);
				}

				const createdAt = Date.now();

				// Insert pending row into D1
				const insertResult = await env.DB.prepare(
					'INSERT INTO feedback (source, text, created_at, analysis_status) VALUES (?, ?, ?, ?)'
				)
					.bind(source, text, createdAt, 'pending')
					.run();

				const feedbackId = insertResult.meta.last_row_id;

				// Run AI analysis
				let analysis: AIAnalysis | null = null;
				let aiLatency = 0;
				let analysisError: string | null = null;
				let aiModel = '';

				try {
					const aiStartTime = Date.now();
					
					// Build prompt for Workers AI
					const prompt = `Analyze the following feedback and return ONLY valid JSON with no additional text:
{
  "sentiment": "positive|neutral|negative",
  "urgency": 1-5,
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "summary": "1-2 line summary"
}

Feedback: ${text}

Return only the JSON object:`;

					const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
						prompt,
						max_tokens: 300,
					});

					aiLatency = Date.now() - aiStartTime;
					aiModel = '@cf/meta/llama-3.1-8b-instruct';

					// Parse AI response
					const responseText = aiResponse.response as string;
					
					// Try to extract JSON from response (handle cases where model adds extra text)
					let jsonMatch = responseText.match(/\{[\s\S]*\}/);
					if (jsonMatch) {
						const parsed = JSON.parse(jsonMatch[0]) as AIAnalysis;
						
						// Validate and normalize
						analysis = {
							sentiment: parsed.sentiment?.toLowerCase() || 'neutral',
							urgency: Math.max(1, Math.min(5, parsed.urgency || 3)),
							tags: (parsed.tags || []).slice(0, 5),
							summary: parsed.summary || 'No summary available',
						};

						// Ensure sentiment is one of the valid values
						if (!['positive', 'neutral', 'negative'].includes(analysis.sentiment)) {
							analysis.sentiment = 'neutral';
						}
					} else {
						throw new Error('No JSON found in AI response');
					}
				} catch (error) {
					analysisError = error instanceof Error ? error.message : 'Unknown error';
					console.error('AI analysis error:', error);
				}

				// Update row with analysis results
				if (analysis) {
					await env.DB.prepare(
						`UPDATE feedback 
						SET sentiment = ?, urgency = ?, tags = ?, summary = ?, 
						    ai_model = ?, ai_latency_ms = ?, analysis_status = 'done'
						WHERE id = ?`
					)
						.bind(
							analysis.sentiment,
							analysis.urgency,
							JSON.stringify(analysis.tags),
							analysis.summary,
							aiModel,
							aiLatency,
							feedbackId
						)
						.run();

					// Emit analytics event for successful AI completion
					env.ANALYTICS?.writeDataPoint({
						blobs: ['ai_completed', '/api/feedback', source, analysis.sentiment],
						doubles: [1, aiLatency],
						indexes: [new Date().toISOString().split('T')[0]],
					});
				} else {
					// Mark as failed
					await env.DB.prepare(
						`UPDATE feedback 
						SET analysis_status = 'failed', analysis_error = ?
						WHERE id = ?`
					)
						.bind(analysisError, feedbackId)
						.run();

					// Emit analytics event for AI failure
					env.ANALYTICS?.writeDataPoint({
						blobs: ['ai_failed', '/api/feedback', source, 'error'],
						doubles: [1, 0],
						indexes: [new Date().toISOString().split('T')[0]],
					});
				}

				// Fetch the complete row to return
				const result = await env.DB.prepare('SELECT * FROM feedback WHERE id = ?')
					.bind(feedbackId)
					.first<FeedbackRow>();

				return new Response(JSON.stringify(result), {
					headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				});
			}

			// Route: Get feedback list (GET /api/feedback)
			if (path === '/api/feedback' && method === 'GET') {
				const limit = parseInt(url.searchParams.get('limit') || '50');
				const sources = url.searchParams.getAll('source');
				const sentiments = url.searchParams.getAll('sentiment');
				const urgencies = url.searchParams.getAll('urgency');
				const tags = url.searchParams.getAll('tag');

				let query = 'SELECT * FROM feedback WHERE 1=1';
				const binds: any[] = [];

				if (sources.length > 0) {
					const placeholders = sources.map(() => '?').join(',');
					query += ` AND source IN (${placeholders})`;
					binds.push(...sources);
				}

				if (sentiments.length > 0) {
					const placeholders = sentiments.map(() => '?').join(',');
					query += ` AND sentiment IN (${placeholders})`;
					binds.push(...sentiments);
				}

				if (urgencies.length > 0) {
					const placeholders = urgencies.map(() => '?').join(',');
					query += ` AND urgency IN (${placeholders})`;
					binds.push(...urgencies.map(u => parseInt(u)));
				}

				if (tags.length > 0) {
					// Filter by tags - tags are stored as JSON array, so we need to check if any tag exists in the array
					const tagConditions = tags.map(() => 'tags LIKE ?');
					query += ' AND (' + tagConditions.join(' OR ') + ')';
					binds.push(...tags.map(tag => `%"${tag}"%`));
				}

				query += ' ORDER BY created_at DESC LIMIT ?';
				binds.push(limit);

				const result = await env.DB.prepare(query)
					.bind(...binds)
					.all<FeedbackRow>();

				return new Response(JSON.stringify(result.results), {
					headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				});
			}

			// Route: Get stats (GET /api/stats)
			if (path === '/api/stats' && method === 'GET') {
				// Get sentiment counts
				const sentimentCounts = await env.DB.prepare(
					'SELECT sentiment, COUNT(*) as count FROM feedback WHERE sentiment IS NOT NULL GROUP BY sentiment'
				).all<{ sentiment: string; count: number }>();

				// Get recent feedback for tag analysis
				const recentFeedback = await env.DB.prepare(
					'SELECT tags FROM feedback WHERE tags IS NOT NULL ORDER BY created_at DESC LIMIT 200'
				).all<{ tags: string }>();

				// Compute top tags
				const tagCounts: Record<string, number> = {};
				for (const row of recentFeedback.results) {
					try {
						const tags = JSON.parse(row.tags) as string[];
						for (const tag of tags) {
							tagCounts[tag] = (tagCounts[tag] || 0) + 1;
						}
					} catch (e) {
						// Skip invalid JSON
					}
				}

				const topTags = Object.entries(tagCounts)
					.sort((a, b) => b[1] - a[1])
					.slice(0, 10)
					.map(([tag, count]) => ({ tag, count }));

				// Get average AI latency
				const avgLatencyResult = await env.DB.prepare(
					'SELECT AVG(ai_latency_ms) as avg_latency FROM feedback WHERE ai_latency_ms IS NOT NULL'
				).first<{ avg_latency: number }>();

				// Get total count
				const totalResult = await env.DB.prepare('SELECT COUNT(*) as total FROM feedback')
					.first<{ total: number }>();

				const stats = {
					sentiment_counts: sentimentCounts.results.reduce((acc, row) => {
						acc[row.sentiment] = row.count;
						return acc;
					}, {} as Record<string, number>),
					top_tags: topTags,
					avg_ai_latency_ms: avgLatencyResult?.avg_latency || 0,
					total_feedback: totalResult?.total || 0,
				};

				return new Response(JSON.stringify(stats), {
					headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				});
			}

			// Route: Seed mock data (POST /api/seed) - for development
			if (path === '/api/seed' && method === 'POST') {
				const mockFeedback = [
					{ source: 'github', text: 'The API is too slow, takes forever to respond' },
					{ source: 'support', text: 'Love the new dashboard design! Very intuitive.' },
					{ source: 'twitter', text: 'Billing page has a bug, charges are incorrect' },
					{ source: 'email', text: 'Documentation needs more examples for beginners' },
					{ source: 'github', text: 'Great work on the authentication system!' },
					{ source: 'support', text: 'Feature request: dark mode support' },
					{ source: 'twitter', text: 'The mobile app crashes on iOS 17' },
					{ source: 'email', text: 'Thank you for the quick response to my issue' },
					{ source: 'github', text: 'Performance has improved significantly in v2.0' },
					{ source: 'support', text: 'Need help with integration, API docs unclear' },
				];

				const results = [];
				for (const feedback of mockFeedback) {
					const seedRequest = new Request('http://localhost/api/feedback', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(feedback),
					});
					
					// Simulate the feedback submission
					const createdAt = Date.now();
					const insertResult = await env.DB.prepare(
						'INSERT INTO feedback (source, text, created_at, analysis_status) VALUES (?, ?, ?, ?)'
					)
						.bind(feedback.source, feedback.text, createdAt, 'pending')
						.run();

					results.push({ id: insertResult.meta.last_row_id, ...feedback });
				}

				return new Response(
					JSON.stringify({ message: `Seeded ${results.length} feedback entries`, results }),
					{ headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
				);
			}

			// 404 for unknown routes
			return new Response('Not Found', { status: 404 });
		} catch (error) {
			console.error('Error:', error);
			return new Response(
				JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
				{ status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
			);
		}
	},
} satisfies ExportedHandler<Env>;

// Dashboard HTML
function getDashboardHTML(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Feedback Radar</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
			background: #0a0a0a;
			min-height: 100vh;
			padding: 20px;
			color: #e0e0e0;
		}
		.container {
			max-width: 1200px;
			margin: 0 auto;
		}
		.header {
			background: #1a1a1a;
			padding: 30px;
			border-radius: 8px;
			border: 1px solid #2a2a2a;
			margin-bottom: 20px;
		}
		.header h1 {
			color: #ffffff;
			margin-bottom: 10px;
			font-weight: 500;
			font-size: 24px;
		}
		.header p {
			color: #888;
			font-size: 14px;
		}
		.stats-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
			gap: 20px;
			margin-bottom: 20px;
		}
		.stat-card {
			background: #1a1a1a;
			padding: 20px;
			border-radius: 8px;
			border: 1px solid #2a2a2a;
		}
		.stat-card h3 {
			color: #888;
			font-size: 12px;
			margin-bottom: 10px;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			font-weight: 500;
		}
		.stat-card .value {
			font-size: 32px;
			font-weight: 600;
			color: #ffffff;
		}
		.form-section {
			background: #1a1a1a;
			padding: 30px;
			border-radius: 8px;
			border: 1px solid #2a2a2a;
			margin-bottom: 20px;
		}
		.form-section h2 {
			margin-bottom: 20px;
			color: #ffffff;
			font-weight: 500;
			font-size: 18px;
		}
		.form-group {
			margin-bottom: 15px;
		}
		.form-group label {
			display: block;
			margin-bottom: 5px;
			color: #b0b0b0;
			font-weight: 500;
			font-size: 14px;
		}
		.form-group select,
		.form-group textarea {
			width: 100%;
			padding: 10px;
			border: 1px solid #2a2a2a;
			border-radius: 6px;
			font-size: 14px;
			font-family: inherit;
			background: #0f0f0f;
			color: #e0e0e0;
		}
		.form-group select:focus,
		.form-group textarea:focus {
			outline: none;
			border-color: #3a3a3a;
		}
		.form-group textarea::placeholder {
			color: #666;
		}
		.form-group select option {
			background: #0f0f0f;
			color: #e0e0e0;
		}
		.form-group textarea {
			min-height: 100px;
			resize: vertical;
		}
		button {
			background: #2a2a2a;
			color: #ffffff;
			border: 1px solid #3a3a3a;
			padding: 10px 20px;
			border-radius: 6px;
			font-size: 14px;
			cursor: pointer;
			transition: all 0.2s;
			font-weight: 500;
		}
		button:hover {
			background: #333;
			border-color: #444;
		}
		button:disabled {
			background: #1a1a1a;
			border-color: #2a2a2a;
			color: #666;
			cursor: not-allowed;
		}
		.feedback-table {
			background: #1a1a1a;
			padding: 30px;
			border-radius: 8px;
			border: 1px solid #2a2a2a;
			overflow-x: auto;
		}
		.feedback-table h2 {
			margin-bottom: 20px;
			color: #ffffff;
			font-weight: 500;
			font-size: 18px;
		}
		table {
			width: 100%;
			border-collapse: collapse;
		}
		th, td {
			padding: 12px;
			text-align: left;
			border-bottom: 1px solid #2a2a2a;
			color: #e0e0e0;
		}
		th {
			background: #0f0f0f;
			font-weight: 600;
			color: #b0b0b0;
			font-size: 12px;
			text-transform: uppercase;
			letter-spacing: 0.5px;
		}
		td {
			font-size: 14px;
		}
		tr:hover td {
			background: #0f0f0f;
		}
		.sentiment-badge {
			display: inline-block;
			padding: 4px 10px;
			border-radius: 4px;
			font-size: 11px;
			font-weight: 500;
		}
		.sentiment-positive {
			background: #1a3a1a;
			color: #4ade80;
			border: 1px solid #2a5a2a;
		}
		.sentiment-neutral {
			background: #3a3a1a;
			color: #fbbf24;
			border: 1px solid #5a5a2a;
		}
		.sentiment-negative {
			background: #3a1a1a;
			color: #f87171;
			border: 1px solid #5a2a2a;
		}
		.tag {
			display: inline-block;
			background: #2a2a2a;
			padding: 3px 10px;
			border-radius: 4px;
			font-size: 11px;
			margin-right: 6px;
			margin-bottom: 4px;
			color: #b0b0b0;
			border: 1px solid #3a3a3a;
		}
		.loading {
			text-align: center;
			padding: 20px;
			color: #888;
		}
		.error {
			background: #3a1a1a;
			color: #f87171;
			padding: 12px;
			border-radius: 6px;
			margin-bottom: 20px;
			border: 1px solid #5a2a2a;
		}
		.success {
			background: #1a3a1a;
			color: #4ade80;
			padding: 12px;
			border-radius: 6px;
			margin-bottom: 20px;
			border: 1px solid #2a5a2a;
		}
		.filter-section {
			background: #1a1a1a;
			padding: 20px;
			border-radius: 8px;
			border: 1px solid #2a2a2a;
			margin-bottom: 20px;
		}
		.filter-section h2 {
			color: #ffffff;
			font-weight: 500;
			font-size: 18px;
			margin-bottom: 15px;
		}
		.filters-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
			gap: 15px;
			margin-bottom: 15px;
		}
		.filter-group {
			display: flex;
			flex-direction: column;
			position: relative;
		}
		.filter-group > label {
			display: block;
			margin-bottom: 8px;
			color: #b0b0b0;
			font-weight: 500;
			font-size: 12px;
			text-transform: uppercase;
			letter-spacing: 0.5px;
		}
		.filter-dropdown {
			position: relative;
		}
		.filter-dropdown-btn {
			width: 100%;
			padding: 10px 12px;
			border: 1px solid #2a2a2a;
			border-radius: 6px;
			font-size: 14px;
			font-family: inherit;
			background: #0f0f0f;
			color: #e0e0e0;
			cursor: pointer;
			text-align: left;
			display: flex;
			justify-content: space-between;
			align-items: center;
		}
		.filter-dropdown-btn:hover {
			border-color: #3a3a3a;
		}
		.filter-dropdown-btn::after {
			content: '▼';
			font-size: 10px;
			color: #888;
			transition: transform 0.2s;
		}
		.filter-dropdown-btn.open::after {
			transform: rotate(180deg);
		}
		.filter-dropdown-panel {
			display: none;
			position: absolute;
			top: 100%;
			left: 0;
			right: 0;
			margin-top: 4px;
			background: #1a1a1a;
			border: 1px solid #2a2a2a;
			border-radius: 6px;
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
			z-index: 1000;
			max-height: 250px;
			overflow-y: auto;
		}
		.filter-dropdown-panel.open {
			display: block;
		}
		.filter-dropdown-panel::-webkit-scrollbar {
			width: 6px;
		}
		.filter-dropdown-panel::-webkit-scrollbar-track {
			background: #1a1a1a;
		}
		.filter-dropdown-panel::-webkit-scrollbar-thumb {
			background: #2a2a2a;
			border-radius: 3px;
		}
		.filter-dropdown-panel::-webkit-scrollbar-thumb:hover {
			background: #3a3a3a;
		}
		.checkbox-group {
			display: flex;
			flex-direction: column;
			gap: 0;
			padding: 4px;
		}
		.checkbox-item {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 8px;
			border-radius: 4px;
		}
		.checkbox-item:hover {
			background: #0f0f0f;
		}
		.checkbox-item input[type="checkbox"] {
			width: 16px;
			height: 16px;
			cursor: pointer;
			accent-color: #3a3a3a;
		}
		.checkbox-item label {
			color: #e0e0e0;
			font-size: 14px;
			cursor: pointer;
			font-weight: normal;
			text-transform: none;
			letter-spacing: normal;
			margin: 0;
			flex: 1;
		}
		.checkbox-item:hover label {
			color: #ffffff;
		}
		.filter-actions {
			display: flex;
			gap: 10px;
		}
		.filter-actions button {
			padding: 8px 16px;
			font-size: 13px;
		}
		.btn-secondary {
			background: #0f0f0f;
			border-color: #2a2a2a;
		}
		.btn-secondary:hover {
			background: #1a1a1a;
			border-color: #3a3a3a;
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<h1>Feedback Radar</h1>
			<p>Analyze and track customer feedback with AI-powered insights</p>
		</div>

		<div class="stats-grid" id="statsGrid">
			<div class="stat-card">
				<h3>Total Feedback</h3>
				<div class="value" id="totalFeedback">-</div>
			</div>
			<div class="stat-card">
				<h3>Positive</h3>
				<div class="value" id="positiveCount">-</div>
			</div>
			<div class="stat-card">
				<h3>Neutral</h3>
				<div class="value" id="neutralCount">-</div>
			</div>
			<div class="stat-card">
				<h3>Negative</h3>
				<div class="value" id="negativeCount">-</div>
			</div>
			<div class="stat-card">
				<h3>Avg AI Latency</h3>
				<div class="value" id="avgLatency">-</div>
			</div>
		</div>

		<div class="form-section">
			<h2>Submit Feedback</h2>
			<div id="message"></div>
			<form id="feedbackForm">
				<div class="form-group">
					<label for="source">Source</label>
					<select id="source" name="source" required>
						<option value="">Select source...</option>
						<option value="github">GitHub</option>
						<option value="support">Support</option>
						<option value="twitter">Twitter</option>
						<option value="email">Email</option>
					</select>
				</div>
				<div class="form-group">
					<label for="text">Feedback Text</label>
					<textarea id="text" name="text" required placeholder="Enter feedback text..."></textarea>
				</div>
				<button type="submit" id="submitBtn">Submit Feedback</button>
			</form>
		</div>

		<div class="filter-section">
			<h2>Filters</h2>
			<div class="filters-grid">
				<div class="filter-group">
					<label>Sentiment</label>
					<div class="filter-dropdown">
						<button type="button" class="filter-dropdown-btn" data-filter="filterSentiment">All Sentiments</button>
						<div class="filter-dropdown-panel" id="filterSentiment">
							<div class="checkbox-group">
								<div class="checkbox-item">
									<input type="checkbox" id="sentiment-positive" value="positive">
									<label for="sentiment-positive">Positive</label>
								</div>
								<div class="checkbox-item">
									<input type="checkbox" id="sentiment-neutral" value="neutral">
									<label for="sentiment-neutral">Neutral</label>
								</div>
								<div class="checkbox-item">
									<input type="checkbox" id="sentiment-negative" value="negative">
									<label for="sentiment-negative">Negative</label>
								</div>
							</div>
						</div>
					</div>
				</div>
				<div class="filter-group">
					<label>Source</label>
					<div class="filter-dropdown">
						<button type="button" class="filter-dropdown-btn" data-filter="filterSource">All Sources</button>
						<div class="filter-dropdown-panel" id="filterSource">
							<div class="checkbox-group">
								<div class="checkbox-item">
									<input type="checkbox" id="source-github" value="github">
									<label for="source-github">GitHub</label>
								</div>
								<div class="checkbox-item">
									<input type="checkbox" id="source-support" value="support">
									<label for="source-support">Support</label>
								</div>
								<div class="checkbox-item">
									<input type="checkbox" id="source-twitter" value="twitter">
									<label for="source-twitter">Twitter</label>
								</div>
								<div class="checkbox-item">
									<input type="checkbox" id="source-email" value="email">
									<label for="source-email">Email</label>
								</div>
							</div>
						</div>
					</div>
				</div>
				<div class="filter-group">
					<label>Urgency</label>
					<div class="filter-dropdown">
						<button type="button" class="filter-dropdown-btn" data-filter="filterUrgency">All Urgency Levels</button>
						<div class="filter-dropdown-panel" id="filterUrgency">
							<div class="checkbox-group">
								<div class="checkbox-item">
									<input type="checkbox" id="urgency-1" value="1">
									<label for="urgency-1">1 - Low</label>
								</div>
								<div class="checkbox-item">
									<input type="checkbox" id="urgency-2" value="2">
									<label for="urgency-2">2</label>
								</div>
								<div class="checkbox-item">
									<input type="checkbox" id="urgency-3" value="3">
									<label for="urgency-3">3 - Medium</label>
								</div>
								<div class="checkbox-item">
									<input type="checkbox" id="urgency-4" value="4">
									<label for="urgency-4">4</label>
								</div>
								<div class="checkbox-item">
									<input type="checkbox" id="urgency-5" value="5">
									<label for="urgency-5">5 - High</label>
								</div>
							</div>
						</div>
					</div>
				</div>
				<div class="filter-group">
					<label>Tag</label>
					<div class="filter-dropdown">
						<button type="button" class="filter-dropdown-btn" data-filter="filterTag">All Tags</button>
						<div class="filter-dropdown-panel" id="filterTag">
							<div class="checkbox-group">
								<!-- Tags will be populated dynamically -->
							</div>
						</div>
					</div>
				</div>
			</div>
			<div class="filter-actions">
				<button type="button" id="applyFilters">Apply Filters</button>
				<button type="button" id="clearFilters" class="btn-secondary">Clear</button>
			</div>
		</div>

		<div class="feedback-table">
			<h2>Latest Feedback</h2>
			<div id="feedbackList" class="loading">Loading...</div>
		</div>
	</div>

	<script>
		// Load stats, tags, and feedback on page load
		loadStats();
		loadTags();
		loadFeedback();

		// Refresh every 10 seconds
		setInterval(() => {
			loadStats();
			loadTags();
			loadFeedback();
		}, 10000);

		// Dropdown toggle functionality
		document.querySelectorAll('.filter-dropdown-btn').forEach(btn => {
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				const filterId = btn.getAttribute('data-filter');
				const panel = document.getElementById(filterId);
				const isOpen = panel.classList.contains('open');
				
				// Close all dropdowns
				document.querySelectorAll('.filter-dropdown-panel').forEach(p => p.classList.remove('open'));
				document.querySelectorAll('.filter-dropdown-btn').forEach(b => b.classList.remove('open'));
				
				// Toggle this dropdown
				if (!isOpen) {
					panel.classList.add('open');
					btn.classList.add('open');
				}
			});
		});

		// Close dropdowns when clicking outside
		document.addEventListener('click', (e) => {
			if (!e.target.closest('.filter-dropdown') && e.target.type !== 'checkbox') {
				document.querySelectorAll('.filter-dropdown-panel').forEach(p => p.classList.remove('open'));
				document.querySelectorAll('.filter-dropdown-btn').forEach(b => b.classList.remove('open'));
			}
		});

		// Prevent dropdown from closing when clicking inside the panel
		document.querySelectorAll('.filter-dropdown-panel').forEach(panel => {
			panel.addEventListener('click', (e) => {
				e.stopPropagation();
			});
		});

		// Update button text when checkboxes change
		function updateButtonText(filterId, defaultText) {
			const btn = document.querySelector('.filter-dropdown-btn[data-filter="' + filterId + '"]');
			const checked = document.querySelectorAll('#' + filterId + ' input[type="checkbox"]:checked');
			if (checked.length === 0) {
				btn.textContent = defaultText;
			} else if (checked.length === 1) {
				const label = document.querySelector('#' + filterId + ' label[for="' + checked[0].id + '"]');
				btn.textContent = label ? label.textContent.split(' (')[0] : checked[0].value;
			} else if (checked.length <= 3) {
				const labels = Array.from(checked).map(cb => {
					const label = document.querySelector('#' + filterId + ' label[for="' + cb.id + '"]');
					return label ? label.textContent.split(' (')[0] : cb.value;
				});
				btn.textContent = labels.join(', ');
			} else {
				btn.textContent = checked.length + ' selected';
			}
		}

		// Filter event listeners - listen to all checkboxes
		const filterGroups = [
			{ id: 'filterSentiment', defaultText: 'All Sentiments' },
			{ id: 'filterSource', defaultText: 'All Sources' },
			{ id: 'filterUrgency', defaultText: 'All Urgency Levels' },
			{ id: 'filterTag', defaultText: 'All Tags' }
		];
		
		filterGroups.forEach(filter => {
			const group = document.getElementById(filter.id);
			if (group) {
				group.addEventListener('change', (e) => {
					if (e.target && e.target.type === 'checkbox') {
						updateButtonText(filter.id, filter.defaultText);
						loadFeedback();
					}
				});
			}
		});

		document.getElementById('applyFilters').addEventListener('click', () => {
			loadFeedback();
		});

		document.getElementById('clearFilters').addEventListener('click', () => {
			// Uncheck all checkboxes
			document.querySelectorAll('#filterSentiment input[type="checkbox"]').forEach(cb => cb.checked = false);
			document.querySelectorAll('#filterSource input[type="checkbox"]').forEach(cb => cb.checked = false);
			document.querySelectorAll('#filterUrgency input[type="checkbox"]').forEach(cb => cb.checked = false);
			document.querySelectorAll('#filterTag input[type="checkbox"]').forEach(cb => cb.checked = false);
			// Update button texts
			updateButtonText('filterSentiment', 'All Sentiments');
			updateButtonText('filterSource', 'All Sources');
			updateButtonText('filterUrgency', 'All Urgency Levels');
			updateButtonText('filterTag', 'All Tags');
			loadFeedback();
		});

		// Handle form submission
		document.getElementById('feedbackForm').addEventListener('submit', async (e) => {
			e.preventDefault();
			const submitBtn = document.getElementById('submitBtn');
			const messageDiv = document.getElementById('message');
			
			submitBtn.disabled = true;
			submitBtn.textContent = 'Submitting...';
			messageDiv.innerHTML = '';

			const formData = {
				source: document.getElementById('source').value,
				text: document.getElementById('text').value,
			};

			try {
				const response = await fetch('/api/feedback', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(formData),
				});

				if (response.ok) {
					const result = await response.json();
					messageDiv.innerHTML = '<div class="success">Feedback submitted successfully! Analyzing...</div>';
					document.getElementById('feedbackForm').reset();
					
					// Poll for analysis completion
					const feedbackId = result.id;
					let pollCount = 0;
					const maxPolls = 20; // Max 20 polls (10 seconds)
					
					const pollInterval = setInterval(async () => {
						pollCount++;
						
						try {
							const checkResponse = await fetch('/api/feedback?limit=100');
							const feedbackList = await checkResponse.json();
							const submittedFeedback = feedbackList.find(f => f.id === feedbackId);
							
							if (submittedFeedback && submittedFeedback.analysis_status === 'done') {
								clearInterval(pollInterval);
								messageDiv.innerHTML = '';
								loadStats();
								loadFeedback();
							} else if (submittedFeedback && submittedFeedback.analysis_status === 'failed') {
								clearInterval(pollInterval);
								messageDiv.innerHTML = '<div class="error">Analysis failed: ' + (submittedFeedback.analysis_error || 'Unknown error') + '</div>';
								loadStats();
								loadFeedback();
							} else if (pollCount >= maxPolls) {
								clearInterval(pollInterval);
								messageDiv.innerHTML = '';
								loadStats();
								loadFeedback();
							}
						} catch (error) {
							// If polling fails, just refresh and clear message
							if (pollCount >= maxPolls) {
								clearInterval(pollInterval);
								messageDiv.innerHTML = '';
								loadStats();
								loadFeedback();
							}
						}
					}, 500); // Poll every 500ms
				} else {
					const error = await response.json();
					messageDiv.innerHTML = '<div class="error">Error: ' + (error.error || 'Failed to submit') + '</div>';
				}
			} catch (error) {
				messageDiv.innerHTML = '<div class="error">Error: ' + error.message + '</div>';
			} finally {
				submitBtn.disabled = false;
				submitBtn.textContent = 'Submit Feedback';
			}
		});

		async function loadStats() {
			try {
				const response = await fetch('/api/stats');
				const stats = await response.json();

				document.getElementById('totalFeedback').textContent = stats.total_feedback || 0;
				document.getElementById('positiveCount').textContent = stats.sentiment_counts?.positive || 0;
				document.getElementById('neutralCount').textContent = stats.sentiment_counts?.neutral || 0;
				document.getElementById('negativeCount').textContent = stats.sentiment_counts?.negative || 0;
				document.getElementById('avgLatency').textContent = 
					stats.avg_ai_latency_ms ? Math.round(stats.avg_ai_latency_ms) + 'ms' : '-';
			} catch (error) {
				console.error('Error loading stats:', error);
			}
		}

		async function loadTags() {
			try {
				const response = await fetch('/api/stats');
				const stats = await response.json();
				const tagPanel = document.getElementById('filterTag');
				const tagGroup = tagPanel.querySelector('.checkbox-group');
				
				// Clear existing checkboxes
				tagGroup.innerHTML = '';
				
				// Add top tags as checkboxes
				if (stats.top_tags && stats.top_tags.length > 0) {
					for (const tagItem of stats.top_tags) {
						const checkboxId = 'tag-' + tagItem.tag.replace(/\s+/g, '-').toLowerCase();
						const checkboxItem = document.createElement('div');
						checkboxItem.className = 'checkbox-item';
						const input = document.createElement('input');
						input.type = 'checkbox';
						input.id = checkboxId;
						input.value = tagItem.tag;
						const label = document.createElement('label');
						label.htmlFor = checkboxId;
						label.textContent = tagItem.tag + ' (' + tagItem.count + ')';
						checkboxItem.appendChild(input);
						checkboxItem.appendChild(label);
						tagGroup.appendChild(checkboxItem);
					}
				}
			} catch (error) {
				console.error('Error loading tags:', error);
			}
		}

		async function loadFeedback() {
			try {
				// Get checked filter values
				const getCheckedValues = (groupId) => {
					const checkboxes = document.querySelectorAll('#' + groupId + ' input[type="checkbox"]:checked');
					return Array.from(checkboxes).map(cb => cb.value);
				};
				
				const sentiments = getCheckedValues('filterSentiment');
				const sources = getCheckedValues('filterSource');
				const urgencies = getCheckedValues('filterUrgency');
				const tags = getCheckedValues('filterTag');
				
				// Build query string
				const params = new URLSearchParams({ limit: '50' });
				sentiments.forEach(s => params.append('sentiment', s));
				sources.forEach(s => params.append('source', s));
				urgencies.forEach(u => params.append('urgency', u));
				tags.forEach(t => params.append('tag', t));
				
				const response = await fetch('/api/feedback?' + params.toString());
				const feedback = await response.json();

				const listDiv = document.getElementById('feedbackList');
				
				if (feedback.length === 0) {
					listDiv.innerHTML = '<p>No feedback yet. Submit some feedback to get started!</p>';
					return;
				}

				let html = '<table><thead><tr><th>ID</th><th>Source</th><th>Sentiment</th><th>Urgency</th><th>Tags</th><th>Summary</th><th>Text</th></tr></thead><tbody>';
				
				for (const item of feedback) {
					const sentimentClass = item.sentiment ? 'sentiment-' + item.sentiment : '';
					const sentimentBadge = item.sentiment 
						? '<span class="sentiment-badge ' + sentimentClass + '">' + item.sentiment + '</span>'
						: '<span class="sentiment-badge">pending</span>';
					
					const tags = item.tags ? JSON.parse(item.tags) : [];
					const tagsHtml = tags.map(tag => '<span class="tag">' + tag + '</span>').join('') || '-';
					
					const summary = item.summary || '-';
					const urgency = item.urgency || '-';
					const text = (item.text || '').substring(0, 100) + (item.text?.length > 100 ? '...' : '');

					html += '<tr>';
					html += '<td>' + item.id + '</td>';
					html += '<td>' + item.source + '</td>';
					html += '<td>' + sentimentBadge + '</td>';
					html += '<td>' + urgency + '</td>';
					html += '<td>' + tagsHtml + '</td>';
					html += '<td>' + summary + '</td>';
					html += '<td>' + text + '</td>';
					html += '</tr>';
				}
				
				html += '</tbody></table>';
				listDiv.innerHTML = html;
			} catch (error) {
				document.getElementById('feedbackList').innerHTML = 
					'<div class="error">Error loading feedback: ' + error.message + '</div>';
			}
		}
	</script>
</body>
</html>`;
}
