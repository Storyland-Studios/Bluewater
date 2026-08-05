<?php
/**
 * Plugin Name: Bluewater Proxy
 * Description: Serves /bluewater from the Bluewater Vercel deployment without changing the URL.
 * Version: 1.1.0
 * Author: Storyland Studios
 */

/**
 * WHY THIS PAGE MUST NOT BE CACHED BY WORDPRESS
 *
 * Version 1.0.0 sent `Cache-Control: public, max-age=300`, and WP Engine's
 * page cache took that as an invitation. The result: a deck deployed to
 * Vercel and verified correct at the Vercel URL kept serving the previous
 * build at /bluewater, with `X-Cache: HIT` and a hit counter climbing, while
 * the same URL with any query string attached returned the new one. Someone
 * presenting from this link would have shown an out-of-date deck with no
 * indication anything was wrong.
 *
 * The document being proxied is already cached where caching belongs: Vercel's
 * CDN serves it with an ETag and answers a revalidation in milliseconds. A
 * second cache layer here buys very little and costs correctness, because
 * nothing in WordPress knows when the deck is redeployed and so nothing ever
 * purges it. A deck is not a blog post; it changes the hour before a meeting.
 *
 * So this asks, in every dialect the stack speaks, not to be cached.
 */

if (!defined('ABSPATH')) {
    exit;
}

const BLUEWATER_ORIGIN = 'https://bluewater-tau.vercel.app';

function bluewater_maybe_proxy() {
    $method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
    if ($method !== 'GET' && $method !== 'HEAD') {
        return;
    }
    $uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '';
    if (!preg_match('#^/bluewater(?:/(?<rest>[^?\s]*))?(?<query>\?[^\s]*)?$#', $uri, $m)) {
        return;
    }
    $rest  = isset($m['rest']) ? ltrim($m['rest'], '/') : '';
    $query = isset($m['query']) ? $m['query'] : '';

    // Understood by W3 Total Cache, WP Rocket, LiteSpeed, Batcache and WP
    // Engine's own layer. Set before any output, which `plugins_loaded` is.
    if (!defined('DONOTCACHEPAGE')) {
        define('DONOTCACHEPAGE', true);
    }

    $resp = wp_remote_get(BLUEWATER_ORIGIN . '/' . $rest . $query, array(
        'timeout'     => 30,
        'redirection' => 3,
        'user-agent'  => 'storylandstudios-bluewater-proxy',
    ));
    if (is_wp_error($resp)) {
        // A failure must not be cached either, or one bad minute at the origin
        // becomes ten minutes of an error page where the deck should be.
        header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
        header('Content-Type: text/plain; charset=utf-8', true, 502);
        echo 'The presentation is temporarily unavailable. Please try again shortly.';
        exit;
    }

    http_response_code((int) wp_remote_retrieve_response_code($resp));
    foreach (array('content-type', 'x-robots-tag') as $name) {
        $value = wp_remote_retrieve_header($resp, $name);
        if ($value) {
            header($name . ': ' . (is_array($value) ? implode(', ', $value) : $value));
        }
    }
    // `private` is the one that most reverse-proxy caches, WP Engine's
    // included, treat as "not yours to store". The rest are for older
    // intermediaries and for the browser.
    header('Cache-Control: private, no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');
    if ($method !== 'HEAD') {
        echo wp_remote_retrieve_body($resp); // phpcs:ignore WordPress.Security.EscapeOutput -- proxied document
    }
    exit;
}
add_action('plugins_loaded', 'bluewater_maybe_proxy');
