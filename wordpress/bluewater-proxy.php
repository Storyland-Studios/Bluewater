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
 *
 * TWO THINGS THIS CANNOT DO BY ITSELF
 *
 * 1. It does not purge what is already cached. It stops future stores. The
 *    object WP Engine is holding stays until it is purged or its TTL lapses,
 *    so deploying this without a purge looks exactly like it did not work.
 *    Purge from the User Portal, or from WP Admin under WP Engine.
 *
 * 2. WP Engine does not promise to honour it. Their documentation says the
 *    page cache TTL is 600s and that "cache-control headers for pages set
 *    lower than 600 will not be effective", with a full page cache exclusion
 *    available only through their support. Varnish's builtin VCL does pass on
 *    no-cache/no-store/private, so this may well be enough — but it is
 *    undocumented, so verify rather than assume: after a purge, request the
 *    path twice and read X-Cache. A second request answering HIT means this
 *    is not working, and the fix is a support ticket for a cache exclusion on
 *    /bluewater, or a cache-bypass rule in their Web Rules engine.
 *
 * Until one of those is in place, a redeploy can be forced through by sending
 * a single request with a `Cache-Control: no-cache` header, which makes the
 * edge revalidate against Vercel and replace what it is holding.
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

    // A free bet on the PHP-level caches, not the load-bearing part. This
    // constant is an advanced-cache.php drop-in convention — W3 Total Cache,
    // WP Rocket, LiteSpeed, Batcache all read it. WP Engine's page cache is
    // edge Varnish/nginx and does not document reading it, so do not rely on
    // this alone; the Cache-Control header further down is what should stop
    // them. Harmless either way, and correct if a drop-in is ever added.
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
        // becomes ten minutes of an error page where the deck should be. Same
        // directives as the success path, deliberately.
        header('Cache-Control: private, no-store, no-cache, must-revalidate, max-age=0');
        header('Content-Type: text/plain; charset=utf-8', true, 502);
        echo 'The presentation is temporarily unavailable. Please try again shortly.';
        exit;
    }

    // A response that is not a WP_Error can still carry no usable status, and
    // `(int) ''` is 0 — an invalid code that php-fpm surfaces as a 500. Treat
    // anything outside the valid range as what it actually is: a bad gateway.
    $code = (int) wp_remote_retrieve_response_code($resp);
    if ($code < 100 || $code > 599) {
        $code = 502;
    }
    http_response_code($code);

    // `location` is in this list because the status above is forwarded
    // verbatim. Without it, a 3xx from the origin — say `redirection` was
    // exhausted — would reach the browser as a redirect with nowhere to go,
    // which renders as a blank page rather than as an error.
    foreach (array('content-type', 'x-robots-tag', 'location') as $name) {
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
