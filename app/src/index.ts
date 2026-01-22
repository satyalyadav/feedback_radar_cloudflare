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
				const source = url.searchParams.get('source');
				const sentiment = url.searchParams.get('sentiment');

				let query = 'SELECT * FROM feedback WHERE 1=1';
				const binds: any[] = [];

				if (source) {
					query += ' AND source = ?';
					binds.push(source);
				}

				if (sentiment) {
					query += ' AND sentiment = ?';
					binds.push(sentiment);
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
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			min-height: 100vh;
			padding: 20px;
		}
		.container {
			max-width: 1200px;
			margin: 0 auto;
		}
		.header {
			background: white;
			padding: 30px;
			border-radius: 10px;
			box-shadow: 0 4px 6px rgba(0,0,0,0.1);
			margin-bottom: 20px;
		}
		.header h1 {
			color: #333;
			margin-bottom: 10px;
		}
		.stats-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
			gap: 20px;
			margin-bottom: 20px;
		}
		.stat-card {
			background: white;
			padding: 20px;
			border-radius: 10px;
			box-shadow: 0 4px 6px rgba(0,0,0,0.1);
		}
		.stat-card h3 {
			color: #666;
			font-size: 14px;
			margin-bottom: 10px;
			text-transform: uppercase;
		}
		.stat-card .value {
			font-size: 32px;
			font-weight: bold;
			color: #333;
		}
		.form-section {
			background: white;
			padding: 30px;
			border-radius: 10px;
			box-shadow: 0 4px 6px rgba(0,0,0,0.1);
			margin-bottom: 20px;
		}
		.form-section h2 {
			margin-bottom: 20px;
			color: #333;
		}
		.form-group {
			margin-bottom: 15px;
		}
		.form-group label {
			display: block;
			margin-bottom: 5px;
			color: #666;
			font-weight: 500;
		}
		.form-group select,
		.form-group textarea {
			width: 100%;
			padding: 10px;
			border: 1px solid #ddd;
			border-radius: 5px;
			font-size: 14px;
			font-family: inherit;
		}
		.form-group textarea {
			min-height: 100px;
			resize: vertical;
		}
		button {
			background: #667eea;
			color: white;
			border: none;
			padding: 12px 24px;
			border-radius: 5px;
			font-size: 16px;
			cursor: pointer;
			transition: background 0.3s;
		}
		button:hover {
			background: #5568d3;
		}
		button:disabled {
			background: #ccc;
			cursor: not-allowed;
		}
		.feedback-table {
			background: white;
			padding: 30px;
			border-radius: 10px;
			box-shadow: 0 4px 6px rgba(0,0,0,0.1);
			overflow-x: auto;
		}
		.feedback-table h2 {
			margin-bottom: 20px;
			color: #333;
		}
		table {
			width: 100%;
			border-collapse: collapse;
		}
		th, td {
			padding: 12px;
			text-align: left;
			border-bottom: 1px solid #eee;
		}
		th {
			background: #f8f9fa;
			font-weight: 600;
			color: #666;
		}
		.sentiment-badge {
			display: inline-block;
			padding: 4px 8px;
			border-radius: 4px;
			font-size: 12px;
			font-weight: 600;
		}
		.sentiment-positive {
			background: #d4edda;
			color: #155724;
		}
		.sentiment-neutral {
			background: #fff3cd;
			color: #856404;
		}
		.sentiment-negative {
			background: #f8d7da;
			color: #721c24;
		}
		.tag {
			display: inline-block;
			background: #e9ecef;
			padding: 2px 8px;
			border-radius: 12px;
			font-size: 11px;
			margin-right: 4px;
			margin-bottom: 4px;
		}
		.loading {
			text-align: center;
			padding: 20px;
			color: #666;
		}
		.error {
			background: #f8d7da;
			color: #721c24;
			padding: 10px;
			border-radius: 5px;
			margin-bottom: 20px;
		}
		.success {
			background: #d4edda;
			color: #155724;
			padding: 10px;
			border-radius: 5px;
			margin-bottom: 20px;
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<h1>📊 Feedback Radar</h1>
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

		<div class="feedback-table">
			<h2>Latest Feedback</h2>
			<div id="feedbackList" class="loading">Loading...</div>
		</div>
	</div>

	<script>
		// Load stats and feedback on page load
		loadStats();
		loadFeedback();

		// Refresh every 10 seconds
		setInterval(() => {
			loadStats();
			loadFeedback();
		}, 10000);

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
					messageDiv.innerHTML = '<div class="success">Feedback submitted successfully! Analyzing...</div>';
					document.getElementById('feedbackForm').reset();
					
					// Wait a bit for AI analysis, then refresh
					setTimeout(() => {
						loadStats();
						loadFeedback();
					}, 2000);
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

		async function loadFeedback() {
			try {
				const response = await fetch('/api/feedback?limit=50');
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
