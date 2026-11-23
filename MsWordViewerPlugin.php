<?php

/**
 * @file plugins/generic/msWordViewer/MsWordViewerPlugin.php
 *
 * Distributed under the GNU GPL v3. For full terms see the file LICENSE.
 *
 * @class MsWordViewerPlugin
 *
 * @brief Adds a "Preview" button next to the download links of Word files (.docx)
 *  on the backend pages. The file is loaded through OJS's own download link (so
 *  OJS's access rules apply) and converted to HTML in the browser with mammoth.js.
 *  Nothing is stored or converted on the server.
 */

namespace APP\plugins\generic\msWordViewer;

use APP\core\Application;
use APP\template\TemplateManager;
use PKP\plugins\GenericPlugin;
use PKP\plugins\Hook;

class MsWordViewerPlugin extends GenericPlugin
{
    public function getName()
    {
        return 'MsWordViewerPlugin';
    }

    public function getDisplayName()
    {
        return __('plugins.generic.msWordViewer.displayName');
    }

    public function getDescription()
    {
        return __('plugins.generic.msWordViewer.description');
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
                'preview' => __('plugins.generic.msWordViewer.preview'),
                'previewOf' => __('plugins.generic.msWordViewer.previewOf', ['name' => '%s']),
                'close' => __('common.close'),
                'download' => __('common.download'),
                'loading' => __('plugins.generic.msWordViewer.loading'),
                'error' => __('plugins.generic.msWordViewer.error'),
                'notDocx' => __('plugins.generic.msWordViewer.notDocx'),
                'notice' => __('plugins.generic.msWordViewer.notice'),
            ],
        ];
        $options = ['contexts' => 'backend'];
        $templateMgr->addJavaScript(
            'msWordViewerConfig',
            'window.msWordViewerConfig = ' . json_encode($config, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP) . ';',
            $options + ['inline' => true]
        );
        $templateMgr->addJavaScript('msWordViewer', "{$base}/js/msWordViewer.js?v={$version}", $options);
        $templateMgr->addStyleSheet('msWordViewer', "{$base}/css/msWordViewer.css?v={$version}", $options);
        return false;
    }
}
