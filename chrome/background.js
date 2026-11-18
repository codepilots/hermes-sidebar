/* Chrome MV3 service worker. Loads the platform adapter then the shared
   background logic. Firefox uses background.scripts (see firefox/manifest.json)
   and needs no wrapper. */
importScripts('platform.js', 'background-common.js');
