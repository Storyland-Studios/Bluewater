<?php
/**
 * Plugin Name: Bluewater26 Proxy
 * Description: Serves /bluewater26 from the Bluewater Vercel deployment without changing the URL.
 * Version: 1.0.0
 * Author: Storyland Studios
 */

if (!defined('ABSPATH')) {
    exit;
}

const BLUEWATER26_ORIGIN = 'https://bluewater-tau.vercel.app';

function bluewater26_maybe_proxy() {
    $method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
    if ($method !== 'GET' && $method !== 'HEAD') {
        return;
    }
    $uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '';
    if (!preg_match('#^/bluewater26(?:/(?<rest>[^?\s]*))?(?<query>\?[^\s]*)?$#', $uri, $m)) {
        return;
    }
    $rest  = isset($m['rest']) ? ltrim($m['rest'], '/') : '';
    $query = isset($m['query']) ? $m['query'] : '';

    $resp = wp_remote_get(BLUEWATER26_ORIGIN . '/' . $rest . $query, array(
        'timeout'     => 30,
        'redirection' => 3,
        'user-agent'  => 'storylandstudios-bluewater26-proxy',
    ));
    if (is_wp_error($resp)) {
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
    header('Cache-Control: public, max-age=300');
    if ($method !== 'HEAD') {
        echo wp_remote_retrieve_body($resp); // phpcs:ignore WordPress.Security.EscapeOutput -- proxied document
    }
    exit;
}
add_action('plugins_loaded', 'bluewater26_maybe_proxy');
