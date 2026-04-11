(function () {
    'use strict';

    // ==========================================
    // Constants
    // ==========================================

    var API_BASE = 'https://www.googleapis.com/youtube/v3';

    // ==========================================
    // Runtime-only state (never persisted)
    // ==========================================

    var state = {
        apiKey: null,       // held in memory only
        isRunning: false,
        shouldCancel: false,
        exportBlob: null,
        exportFilename: null
    };

    // ==========================================
    // DOM element cache
    // ==========================================

    var dom = {};

    // ==========================================
    // ApiError
    // ==========================================

    function ApiError(message, status, reason) {
        this.name = 'ApiError';
        this.message = message;
        this.status = status;
        this.reason = reason;
    }
    ApiError.prototype = Object.create(Error.prototype);

    // ==========================================
    // Utility helpers
    // ==========================================

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /** Extract a YouTube video ID from a URL or raw ID string. */
    function extractVideoId(input) {
        input = (input || '').trim();
        if (!input) return null;

        var urlPattern = /(?:youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        var match = input.match(urlPattern);
        if (match) return match[1];

        if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

        return null;
    }

    /** Escape a value for CSV output. */
    function escapeCsv(value) {
        if (value == null) return '';
        var str = String(value);
        if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1 || str.indexOf('\r') !== -1) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    /** Format a number with locale separators. */
    function fmtNum(n) {
        return Number(n).toLocaleString();
    }

    /** Return an ISO timestamp string. */
    function isoNow() {
        return new Date().toISOString();
    }

    // ==========================================
    // YouTube API request helpers
    // ==========================================

    /**
     * Make a request to the YouTube Data API v3.
     * The API key is read from runtime state on every call.
     */
    async function apiRequest(endpoint, params) {
        var url = new URL(API_BASE + '/' + endpoint);
        params.key = state.apiKey;

        Object.keys(params).forEach(function (k) {
            if (params[k] != null) url.searchParams.set(k, params[k]);
        });

        var response = await fetch(url.toString());

        if (!response.ok) {
            var body = {};
            try { body = await response.json(); } catch (_) { /* ignore */ }
            var msg = (body.error && body.error.message) ? body.error.message : 'API error: ' + response.status;
            var reason = (body.error && body.error.errors && body.error.errors[0]) ? body.error.errors[0].reason : '';
            throw new ApiError(msg, response.status, reason);
        }

        return response.json();
    }

    /** Search for videos via search.list. */
    function searchVideos(query, language, pageToken) {
        return apiRequest('search', {
            part: 'snippet',
            q: query,
            type: 'video',
            maxResults: 50,
            relevanceLanguage: language,
            pageToken: pageToken || null
        });
    }

    /** Get video details via videos.list. */
    function getVideoDetails(videoIds) {
        return apiRequest('videos', {
            part: 'snippet,statistics',
            id: videoIds.join(',')
        });
    }

    /** Fetch a page of comment threads for a video. */
    function getCommentThreads(videoId, pageToken, maxResults) {
        return apiRequest('commentThreads', {
            part: 'snippet,replies',
            videoId: videoId,
            maxResults: maxResults || 100,
            textFormat: 'plainText',
            pageToken: pageToken || null
        });
    }

    /** Fetch a page of replies for a given parent comment. */
    function getCommentReplies(parentId, pageToken) {
        return apiRequest('comments', {
            part: 'snippet',
            parentId: parentId,
            maxResults: 100,
            textFormat: 'plainText',
            pageToken: pageToken || null
        });
    }

    // ==========================================
    // Comment processing
    // ==========================================

    /** Format a single comment resource into our export shape. */
    function formatComment(comment, isReply) {
        var s = comment.snippet;
        return {
            comment_id: comment.id,
            parent_id: isReply ? (s.parentId || null) : null,
            author: s.authorDisplayName || '',
            text_display: s.textDisplay || '',
            text_original: s.textOriginal || '',
            like_count: s.likeCount || 0,
            published_at: s.publishedAt || '',
            updated_at: s.updatedAt || '',
            is_reply: isReply
        };
    }

    /** Fetch ALL replies for a given top-level comment via pagination. */
    async function fetchAllReplies(parentId) {
        var allReplies = [];
        var pageToken = null;

        do {
            if (state.shouldCancel) break;
            var resp = await getCommentReplies(parentId, pageToken);
            if (resp.items) {
                resp.items.forEach(function (item) {
                    allReplies.push(formatComment(item, true));
                });
            }
            pageToken = resp.nextPageToken || null;
            if (pageToken) await delay(50);
        } while (pageToken);

        return allReplies;
    }

    /**
     * Fetch ALL comments (top-level + replies) for a video.
     * Provides progress via the onProgress callback.
     */
    async function getAllComments(videoId, onProgress) {
        var allComments = [];
        var pageToken = null;
        var pageNum = 0;

        do {
            if (state.shouldCancel) break;
            pageNum++;
            debugLog('Fetching comment threads page ' + pageNum + ' for ' + videoId + '...');

            var resp = await getCommentThreads(videoId, pageToken);
            if (!resp.items || resp.items.length === 0) break;

            for (var i = 0; i < resp.items.length; i++) {
                if (state.shouldCancel) break;

                var thread = resp.items[i];
                var topComment = thread.snippet.topLevelComment;
                allComments.push(formatComment(topComment, false));

                var totalReplies = thread.snippet.totalReplyCount || 0;
                if (totalReplies > 0) {
                    var inlineReplies = (thread.replies && thread.replies.comments) ? thread.replies.comments : [];

                    if (totalReplies <= inlineReplies.length) {
                        // All replies are available inline
                        inlineReplies.forEach(function (r) {
                            allComments.push(formatComment(r, true));
                        });
                    } else {
                        // Need separate pagination for replies
                        var fullReplies = await fetchAllReplies(topComment.id);
                        allComments = allComments.concat(fullReplies);
                    }
                }
            }

            if (onProgress) onProgress(allComments.length);
            debugLog('  ' + fmtNum(allComments.length) + ' comments fetched so far');

            pageToken = resp.nextPageToken || null;
            if (pageToken) await delay(80);
        } while (pageToken);

        return allComments;
    }

    // ==========================================
    // Export builders
    // ==========================================

    /** Build the top-level video export object. */
    function buildVideoExport(videoResource, comments, searchRank) {
        var s = videoResource.snippet;
        return {
            video_id: videoResource.id,
            title: s.title || '',
            channel_title: s.channelTitle || '',
            description: s.description || '',
            published_at: s.publishedAt || '',
            url: 'https://www.youtube.com/watch?v=' + videoResource.id,
            search_rank: searchRank,
            comment_count_exported: comments.length,
            comments: comments
        };
    }

    /** Build the full JSON export object. */
    function buildJsonExport(params) {
        return {
            mode: params.mode,
            search_term: params.searchTerm || null,
            direct_video_input: params.directInput || null,
            language: params.language,
            requested_video_count: params.requestedCount,
            actual_video_count: params.videos.length,
            exported_at: isoNow(),
            export_format: 'json',
            videos: params.videos
        };
    }

    /** Build a CSV string from the export data. */
    function buildCsvExport(exportData) {
        var headers = [
            'mode', 'search_term', 'language', 'video_id', 'video_title',
            'channel_title', 'search_rank', 'comment_id', 'parent_id',
            'author', 'text_display', 'text_original', 'like_count',
            'published_at', 'updated_at', 'is_reply'
        ];

        var rows = [headers.join(',')];

        exportData.videos.forEach(function (video) {
            video.comments.forEach(function (c) {
                rows.push([
                    escapeCsv(exportData.mode),
                    escapeCsv(exportData.search_term || ''),
                    escapeCsv(exportData.language),
                    escapeCsv(video.video_id),
                    escapeCsv(video.title),
                    escapeCsv(video.channel_title),
                    video.search_rank != null ? video.search_rank : '',
                    escapeCsv(c.comment_id),
                    escapeCsv(c.parent_id || ''),
                    escapeCsv(c.author),
                    escapeCsv(c.text_display),
                    escapeCsv(c.text_original),
                    c.like_count,
                    c.published_at,
                    c.updated_at,
                    c.is_reply
                ].join(','));
            });
        });

        return rows.join('\n');
    }

    /** Trigger a file download in the browser. */
    function downloadBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ==========================================
    // UI helpers
    // ==========================================

    function getMode() {
        return dom.modeSearch.classList.contains('tab-active') ? 'search' : 'direct_video';
    }

    function setMode(mode) {
        if (mode === 'search') {
            dom.modeSearch.classList.add('tab-active');
            dom.modeDirect.classList.remove('tab-active');
            dom.searchOptions.classList.remove('hidden');
            dom.directOptions.classList.add('hidden');
        } else {
            dom.modeDirect.classList.add('tab-active');
            dom.modeSearch.classList.remove('tab-active');
            dom.directOptions.classList.remove('hidden');
            dom.searchOptions.classList.add('hidden');
        }
    }

    function updateProgress(text) {
        dom.progressStatus.textContent = text;
    }

    function setProgressPercent(pct) {
        dom.progressBar.value = Math.min(100, Math.max(0, pct));
    }

    function setProgressIndeterminate() {
        dom.progressBar.removeAttribute('value');
    }

    function debugLog(message) {
        if (!dom.debugMode.checked) return;

        var time = new Date().toLocaleTimeString();
        var entry = document.createElement('div');
        entry.className = 'log-entry';

        var cssClass = 'log-time';
        if (/skip|unavailable|disabled/i.test(message)) cssClass = 'log-skip';
        else if (/error|fail/i.test(message)) cssClass = 'log-error';
        else if (/qualif|done|complete|success/i.test(message)) cssClass = 'log-ok';

        entry.innerHTML = '<span class="log-time">[' + time + ']</span> <span class="' + cssClass + '">' + escapeHtml(message) + '</span>';
        dom.debugLog.appendChild(entry);
        dom.debugLog.scrollTop = dom.debugLog.scrollHeight;

        console.log('[YTExport] ' + message);
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    function showError(message) {
        clearErrors();

        var el = document.createElement('div');
        el.setAttribute('role', 'alert');
        el.className = 'alert alert-error mb-4';
        el.setAttribute('data-yt-error', '');
        el.innerHTML = '<span>' + escapeHtml(message) + '</span>';

        dom.errorContainer.appendChild(el);
    }

    function clearErrors() {
        document.querySelectorAll('[data-yt-error]').forEach(function (el) { el.remove(); });
    }

    function setRunning(running) {
        state.isRunning = running;
        dom.startBtn.disabled = running;
        dom.cancelBtn.classList.toggle('hidden', !running);

        if (running) {
            state.shouldCancel = false;
            state.exportBlob = null;
            state.exportFilename = null;
            clearErrors();
            dom.progressSection.classList.remove('hidden');
            dom.resultSection.classList.add('hidden');
            dom.progressStatus.textContent = '';
            setProgressPercent(0);

            if (dom.debugMode.checked) {
                dom.debugSection.classList.remove('hidden');
                dom.debugLog.innerHTML = '';
            }
        }
    }

    function showResults(summary) {
        dom.resultSection.classList.remove('hidden');
        dom.resultSummary.innerHTML = summary;
    }

    // ==========================================
    // Main export flows
    // ==========================================

    /** Validate common inputs and set the API key into state. */
    function validateAndSetKey() {
        var key = dom.apiKey.value.trim();
        if (!key) {
            showError('Please enter your YouTube Data API v3 key.');
            return false;
        }
        state.apiKey = key;
        return true;
    }

    /** Entry point: start the export. */
    async function startExport() {
        if (state.isRunning) return;

        if (!validateAndSetKey()) return;

        setRunning(true);
        debugLog('Export started — mode: ' + getMode());

        try {
            var result;
            if (getMode() === 'search') {
                result = await runSearchMode();
            } else {
                result = await runDirectMode();
            }

            if (state.shouldCancel) {
                updateProgress('Export cancelled.');
                debugLog('Export cancelled by user.');
                return;
            }

            if (!result || result.videos.length === 0) {
                updateProgress('No videos with exportable comments were found.');
                debugLog('No qualifying videos found.');
                return;
            }

            // Build final export
            var format = dom.outputFormat.value;
            var content, mimeType, ext;

            if (format === 'csv') {
                var csvText = buildCsvExport(result);
                // UTF-8 BOM for Excel compatibility
                content = '\ufeff' + csvText;
                mimeType = 'text/csv;charset=utf-8';
                ext = 'csv';
            } else {
                content = JSON.stringify(result, null, 2);
                mimeType = 'application/json;charset=utf-8';
                ext = 'json';
            }

            var dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            var filename = 'youtube-comments-' + dateStr + '.' + ext;

            state.exportBlob = new Blob([content], { type: mimeType });
            state.exportFilename = filename;

            // Summary
            var totalComments = 0;
            result.videos.forEach(function (v) { totalComments += v.comment_count_exported; });

            setProgressPercent(100);
            updateProgress('Export complete!');
            debugLog('Export complete. ' + result.videos.length + ' videos, ' + fmtNum(totalComments) + ' comments.');

            var summaryHtml = '<p class="flex flex-wrap gap-2 mb-2">'
                + '<span class="badge badge-primary">' + result.actual_video_count + ' video' + (result.actual_video_count !== 1 ? 's' : '') + '</span> '
                + '<span class="badge badge-primary">' + fmtNum(totalComments) + ' comments</span> '
                + '<span class="badge badge-primary">' + format.toUpperCase() + '</span>'
                + '</p>';

            if (result.mode === 'search' && result.actual_video_count < result.requested_video_count) {
                summaryHtml += '<p><span class="badge badge-warning">Requested ' + result.requested_video_count
                    + ' videos but only ' + result.actual_video_count + ' with exportable comments were available.</span></p>';
            }

            summaryHtml += '<p>File: <strong>' + filename + '</strong></p>';
            showResults(summaryHtml);

        } catch (err) {
            if (!state.shouldCancel) {
                var errMsg = err.message || String(err);
                if (err.status === 403 && err.reason === 'quotaExceeded') {
                    errMsg = 'YouTube API quota exceeded. Please wait or use a different API key.';
                }
                showError(errMsg);
                updateProgress('Export failed.');
                debugLog('FATAL: ' + errMsg);
            }
        } finally {
            setRunning(false);
        }
    }

    // ------------------------------------------
    // Search mode
    // ------------------------------------------

    async function runSearchMode() {
        var searchTerm = dom.searchTerm.value.trim();
        var requestedCount = parseInt(dom.videoCount.value, 10) || 20;
        var language = dom.language.value;

        if (!searchTerm) {
            showError('Please enter a search term.');
            return null;
        }

        var qualifyingVideos = [];
        var skippedCount = 0;
        var searchPageToken = null;
        var searchPageNum = 0;

        updateProgress('Searching for videos matching "' + searchTerm + '"...');

        // Phase 1: find qualifying videos
        while (qualifyingVideos.length < requestedCount) {
            if (state.shouldCancel) break;

            searchPageNum++;
            debugLog('Loading search results page ' + searchPageNum + '...');

            var searchResult;
            try {
                searchResult = await searchVideos(searchTerm, language, searchPageToken);
            } catch (err) {
                debugLog('Search API error: ' + err.message);
                throw err;
            }

            if (!searchResult.items || searchResult.items.length === 0) {
                debugLog('No more search results available.');
                break;
            }

            debugLog('Received ' + searchResult.items.length + ' search results.');

            // Filter to videos only (should already be filtered by type=video, but be safe)
            var videoIds = [];
            searchResult.items.forEach(function (item) {
                if (item.id && item.id.videoId) {
                    videoIds.push(item.id.videoId);
                }
            });

            if (videoIds.length === 0) {
                searchPageToken = searchResult.nextPageToken || null;
                if (!searchPageToken) break;
                continue;
            }

            // Get video details
            var details;
            try {
                details = await getVideoDetails(videoIds);
            } catch (err) {
                debugLog('Video details API error: ' + err.message);
                searchPageToken = searchResult.nextPageToken || null;
                if (!searchPageToken) break;
                continue;
            }

            if (!details.items) {
                searchPageToken = searchResult.nextPageToken || null;
                if (!searchPageToken) break;
                continue;
            }

            // Check each video for comment availability
            for (var i = 0; i < details.items.length; i++) {
                if (state.shouldCancel) break;
                if (qualifyingVideos.length >= requestedCount) break;

                var video = details.items[i];
                var title = video.snippet.title;
                var vid = video.id;

                debugLog('Checking candidate: "' + title + '" (' + vid + ')');

                try {
                    var testComments = await getCommentThreads(vid, null, 1);
                    if (testComments.items && testComments.items.length > 0) {
                        qualifyingVideos.push({
                            details: video,
                            searchRank: qualifyingVideos.length + 1
                        });
                        debugLog('  Qualifies (' + qualifyingVideos.length + '/' + requestedCount + ')');
                        updateProgress('Found ' + qualifyingVideos.length + ' of ' + requestedCount + ' qualifying videos...\nLatest: "' + title + '"');
                        setProgressPercent((qualifyingVideos.length / requestedCount) * 50);
                    } else {
                        skippedCount++;
                        debugLog('  Skipped — no comments found');
                    }
                } catch (err) {
                    skippedCount++;
                    var skipReason = (err.reason === 'commentsDisabled') ? 'comments disabled' : err.message;
                    debugLog('  Skipped — ' + skipReason);
                }

                await delay(50);
            }

            searchPageToken = searchResult.nextPageToken || null;
            if (!searchPageToken) {
                debugLog('No more search result pages available.');
                break;
            }
        }

        if (qualifyingVideos.length === 0) return null;

        debugLog(qualifyingVideos.length + ' qualifying video(s) found. ' + skippedCount + ' skipped.');
        debugLog('Starting comment export...');

        // Phase 2: export comments for qualifying videos
        var exportVideos = [];
        var totalComments = 0;

        for (var j = 0; j < qualifyingVideos.length; j++) {
            if (state.shouldCancel) break;

            var qv = qualifyingVideos[j];
            var vTitle = qv.details.snippet.title;
            var vId = qv.details.id;

            updateProgress('Exporting comments (' + (j + 1) + '/' + qualifyingVideos.length + '): "' + vTitle + '"\n' + fmtNum(totalComments) + ' comments exported so far');
            debugLog('Processing video ' + (j + 1) + '/' + qualifyingVideos.length + ': "' + vTitle + '"');

            try {
                var comments = await getAllComments(vId, function (count) {
                    updateProgress('Exporting comments (' + (j + 1) + '/' + qualifyingVideos.length + '): "' + vTitle + '"\n' + fmtNum(totalComments + count) + ' comments exported so far');
                });

                totalComments += comments.length;
                exportVideos.push(buildVideoExport(qv.details, comments, qv.searchRank));
                debugLog('  Done: ' + fmtNum(comments.length) + ' comments (' + fmtNum(totalComments) + ' total)');

            } catch (err) {
                debugLog('  Error exporting comments: ' + err.message + ' — skipping video');
            }

            var exportProgress = 50 + ((j + 1) / qualifyingVideos.length) * 50;
            setProgressPercent(exportProgress);
        }

        return buildJsonExport({
            mode: 'search',
            searchTerm: searchTerm,
            directInput: null,
            language: language,
            requestedCount: requestedCount,
            videos: exportVideos
        });
    }

    // ------------------------------------------
    // Direct video mode
    // ------------------------------------------

    async function runDirectMode() {
        var rawInput = dom.videoInput.value.trim();
        if (!rawInput) {
            showError('Please enter a YouTube video URL or video ID.');
            return null;
        }

        var videoId = extractVideoId(rawInput);
        if (!videoId) {
            showError('Could not extract a valid video ID from the input. Please check the URL or ID.');
            return null;
        }

        debugLog('Extracted video ID: ' + videoId);
        updateProgress('Fetching video details...');
        setProgressIndeterminate();

        // Get video details
        var details;
        try {
            details = await getVideoDetails([videoId]);
        } catch (err) {
            throw new Error('Failed to fetch video details: ' + err.message);
        }

        if (!details.items || details.items.length === 0) {
            throw new Error('Video not found. Please check the video ID or URL.');
        }

        var video = details.items[0];
        var title = video.snippet.title;
        debugLog('Video found: "' + title + '"');
        updateProgress('Exporting comments for "' + title + '"...');

        // Get all comments
        var comments;
        try {
            comments = await getAllComments(videoId, function (count) {
                updateProgress('Exporting comments for "' + title + '"\n' + fmtNum(count) + ' comments fetched so far');
            });
        } catch (err) {
            if (err.reason === 'commentsDisabled') {
                throw new Error('Comments are disabled for this video.');
            }
            throw new Error('Failed to fetch comments: ' + err.message);
        }

        if (comments.length === 0) {
            debugLog('No comments found for this video.');
        }

        var language = dom.language.value;
        var exportVideo = buildVideoExport(video, comments, null);

        return buildJsonExport({
            mode: 'direct_video',
            searchTerm: null,
            directInput: rawInput,
            language: language,
            requestedCount: 1,
            videos: [exportVideo]
        });
    }

    // ==========================================
    // Cancel
    // ==========================================

    function cancelExport() {
        state.shouldCancel = true;
        debugLog('Cancellation requested...');
        updateProgress('Cancelling...');
    }

    // ==========================================
    // Download
    // ==========================================

    function downloadExport() {
        if (state.exportBlob && state.exportFilename) {
            downloadBlob(state.exportBlob, state.exportFilename);
        }
    }

    // ==========================================
    // Initialization
    // ==========================================

    function init() {
        // Cache DOM references
        dom.apiKey = document.getElementById('apiKey');
        dom.toggleKeyBtn = document.getElementById('toggleKeyBtn');
        dom.modeSearch = document.getElementById('modeSearch');
        dom.modeDirect = document.getElementById('modeDirect');
        dom.searchOptions = document.getElementById('searchOptions');
        dom.directOptions = document.getElementById('directOptions');
        dom.searchTerm = document.getElementById('searchTerm');
        dom.videoCount = document.getElementById('videoCount');
        dom.videoInput = document.getElementById('videoInput');
        dom.language = document.getElementById('language');
        dom.outputFormat = document.getElementById('outputFormat');
        dom.debugMode = document.getElementById('debugMode');
        dom.startBtn = document.getElementById('startBtn');
        dom.cancelBtn = document.getElementById('cancelBtn');
        dom.progressSection = document.getElementById('progressSection');
        dom.progressBar = document.getElementById('progressBar');
        dom.progressStatus = document.getElementById('progressStatus');
        dom.errorContainer = document.getElementById('errorContainer');
        dom.debugSection = document.getElementById('debugSection');
        dom.debugLog = document.getElementById('debugLog');
        dom.resultSection = document.getElementById('resultSection');
        dom.resultSummary = document.getElementById('resultSummary');
        dom.downloadBtn = document.getElementById('downloadBtn');

        // Event listeners
        dom.modeSearch.addEventListener('click', function () { setMode('search'); });
        dom.modeDirect.addEventListener('click', function () { setMode('direct'); });
        dom.startBtn.addEventListener('click', startExport);
        dom.cancelBtn.addEventListener('click', cancelExport);
        dom.downloadBtn.addEventListener('click', downloadExport);

        dom.toggleKeyBtn.addEventListener('click', function () {
            var isPassword = dom.apiKey.type === 'password';
            dom.apiKey.type = isPassword ? 'text' : 'password';
            dom.toggleKeyBtn.textContent = isPassword ? 'Hide' : 'Show';
        });

        dom.debugMode.addEventListener('change', function () {
            if (dom.debugMode.checked) {
                dom.debugSection.classList.remove('hidden');
            } else {
                dom.debugSection.classList.add('hidden');
            }
        });

        debugLog('App initialized.');
    }

    // Start when the DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
