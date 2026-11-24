<?php

/**
 * @file plugins/generic/documentPreview/DocumentPreviewPlugin.php
 *
 * Distributed under the GNU GPL v3. For full terms see the file LICENSE.
 *
 * @class DocumentPreviewPlugin
 *
 * @brief Adds a "Preview" button to the download links of submission files on the
 *  backend pages. The file is loaded through OJS's own download link (so OJS's
 *  access rules apply) and converted to HTML in the browser by a renderer for its
 *  format. Nothing is converted or stored on the server.
 *
 *  Renderers are browser scripts that register with the core script
 *  (js/documentPreview.js). This class tells the page which renderers exist and
 *  which formats they read; other plugins can add renderers with the hook
 *  "DocumentPreview::renderers".
 */

namespace APP\plugins\generic\documentPreview;

use APP\core\Application;
use APP\template\TemplateManager;
use PKP\plugins\GenericPlugin;
use PKP\plugins\Hook;

class DocumentPreviewPlugin extends GenericPlugin
{
    public function getName()
    {
        return 'DocumentPreviewPlugin';
    }

    public function getDisplayName()
    {
        return __('plugins.generic.documentPreview.displayName');
    }

    public function getDescription()
    {
        return __('plugins.generic.documentPreview.description');
    }

    public function register($category, $path, $mainContextId = null)
    {
        $success = parent::register($category, $path, $mainContextId);
        if ($success && $this->getEnabled($mainContextId)) {
            Hook::add('TemplateManager::display', $this->addAssets(...));
        }
        return $success;
    }

    /**
     * The renderers, by id:
     *
     *   'script'     URL of the browser script that registers the renderer under this id
     *   'extensions' file name extensions it reads (lower case, without the dot)
     *   'mimeTypes'  media types it reads (for files whose name has no extension)
     *   'options'    passed to the renderer's render function, e.g. URLs of libraries
     *
     * @hook DocumentPreview::renderers [[&$renderers, $plugin]]
     */
    public function getRenderers(string $baseUrl, string $version): array
    {
        $renderers = [
            'docx' => [
                'script' => "{$baseUrl}/js/renderers/docx.js?v={$version}",
                'extensions' => ['docx'],
                'mimeTypes' => ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
                'options' => [
                    'mammothUrl' => "{$baseUrl}/js/lib/mammoth.browser.min.js?v={$version}",
                ],
            ],
            'odt' => [
                'script' => "{$baseUrl}/js/renderers/odt.js?v={$version}",
                'extensions' => ['odt', 'fodt'],
                'mimeTypes' => [
                    'application/vnd.oasis.opendocument.text',
                    'application/vnd.oasis.opendocument.text-flat-xml',
                ],
            ],
        ];
        Hook::call('DocumentPreview::renderers', [&$renderers, $this]);
        return $renderers;
    }

    /**
     * Core script, renderer scripts, styles and texts for the backend pages of
     * logged-in users. Assets with the context "backend" are not included in the
     * reader-facing website.
     */
    public function addAssets(string $hookName, array $args): bool
    {
        $request = Application::get()->getRequest();
        if (!$request->getContext() || !$request->getUser()) {
            return false;
        }
        $templateMgr = $args[0]; /** @var TemplateManager $templateMgr */
        $base = $request->getBaseUrl() . '/' . $this->getPluginPath();
        $version = $this->getCurrentVersion()?->getVersionString() ?? '';
        $renderers = $this->getRenderers($base, $version);

        $config = [
            'renderers' => array_map(
                fn (array $renderer) => [
                    'extensions' => array_values(array_map('strtolower', $renderer['extensions'] ?? [])),
                    'mimeTypes' => array_values(array_map('strtolower', $renderer['mimeTypes'] ?? [])),
                    'options' => (object) ($renderer['options'] ?? []),
                ],
                $renderers
            ),
            'text' => [
                'preview' => __('plugins.generic.documentPreview.preview'),
                'previewOf' => __('plugins.generic.documentPreview.previewOf', ['name' => '%s']),
                'file' => __('plugins.generic.documentPreview.file'),
                'close' => __('common.close'),
                'download' => __('common.download'),
                'loading' => __('plugins.generic.documentPreview.loading'),
                'error' => __('plugins.generic.documentPreview.error'),
                'unsupported' => __('plugins.generic.documentPreview.unsupported'),
                'notice' => __('plugins.generic.documentPreview.notice'),
            ],
        ];
        $options = ['contexts' => 'backend'];
        $templateMgr->addJavaScript(
            'documentPreviewConfig',
            'window.documentPreviewConfig = ' . json_encode($config, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP) . ';',
            $options + ['inline' => true]
        );
        $templateMgr->addJavaScript('documentPreview', "{$base}/js/documentPreview.js?v={$version}", $options);
        foreach ($renderers as $id => $renderer) {
            $templateMgr->addJavaScript("documentPreview-{$id}", $renderer['script'], $options);
        }
        $templateMgr->addStyleSheet('documentPreview', "{$base}/css/documentPreview.css?v={$version}", $options);
        return false;
    }
}
