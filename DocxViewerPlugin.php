<?php

/**
 * @file plugins/generic/docxViewer/DocxViewerPlugin.php
 *
 * Distributed under the GNU GPL v3. For full terms see the file LICENSE.
 *
 * @class DocxViewerPlugin
 *
 * @brief Adds a "Preview" button next to the download links of DOCX documents
 *  on the backend pages. The file is loaded through OJS's own download link (so
 *  OJS's access rules apply) and converted to HTML in the browser with mammoth.js.
 *  Nothing is stored or converted on the server.
 */

namespace APP\plugins\generic\docxViewer;

use APP\core\Application;
use APP\template\TemplateManager;
use PKP\plugins\GenericPlugin;
use PKP\plugins\Hook;

class DocxViewerPlugin extends GenericPlugin
{
    public function getName()
    {
        return 'DocxViewerPlugin';
    }

    public function getDisplayName()
    {
        return __('plugins.generic.docxViewer.displayName');
    }

    public function getDescription()
    {
        return __('plugins.generic.docxViewer.description');
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
     * Script, styles and texts for the backend pages of logged-in users. Assets with
     * the context "backend" are not included in the reader-facing website.
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
        $config = [
            'mammothUrl' => "{$base}/js/lib/mammoth.browser.min.js?v={$version}",
            'text' => [
                'preview' => __('plugins.generic.docxViewer.preview'),
                'previewOf' => __('plugins.generic.docxViewer.previewOf', ['name' => '%s']),
                'close' => __('common.close'),
                'download' => __('common.download'),
                'loading' => __('plugins.generic.docxViewer.loading'),
                'error' => __('plugins.generic.docxViewer.error'),
                'notDocx' => __('plugins.generic.docxViewer.notDocx'),
                'notice' => __('plugins.generic.docxViewer.notice'),
            ],
        ];
        $options = ['contexts' => 'backend'];
        $templateMgr->addJavaScript(
            'docxViewerConfig',
            'window.docxViewerConfig = ' . json_encode($config, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP) . ';',
            $options + ['inline' => true]
        );
        $templateMgr->addJavaScript('docxViewer', "{$base}/js/docxViewer.js?v={$version}", $options);
        $templateMgr->addStyleSheet('docxViewer', "{$base}/css/docxViewer.css?v={$version}", $options);
        return false;
    }
}
