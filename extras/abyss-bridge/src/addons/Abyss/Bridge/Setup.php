<?php

namespace Abyss\Bridge;

use XF\AddOn\AbstractSetup;
use XF\AddOn\StepRunnerInstallTrait;
use XF\AddOn\StepRunnerUninstallTrait;
use XF\AddOn\StepRunnerUpgradeTrait;

/**
 * Options and option group are created via Admin CP after install (one-time),
 * then captured to _data/options.xml and _data/option_groups.xml by running:
 *
 *     php cmd.php xf-addon:export Abyss/Bridge
 *
 * That export-from-DB workflow is the documented path — XF has no public
 * helper for installing options from PHP. Schema details vary across point
 * releases, so hand-rolled SQL in Setup.php is fragile.
 */
class Setup extends AbstractSetup
{
    use StepRunnerInstallTrait;
    use StepRunnerUpgradeTrait;
    use StepRunnerUninstallTrait;

    public function installStep1(): void
    {
        // No schema or data steps. The addon's only persistent state lives in
        // XF's option/phrase tables, which are created via Admin CP and then
        // exported to _data/*.xml by xf-addon:export.
    }

    public function upgrade1000010Step1(): void
    {
        // Reserved for future schema changes.
    }

    public function upgrade1000020Step1(): void
    {
        // 1.1.0 adds code_event_listeners (live thread mirror webhooks).
        // No schema changes; XF imports the new listeners from _data/.
    }

    public function uninstallStep1(): void
    {
        // Options/groups/phrases owned by this addon (addon_id='Abyss/Bridge')
        // are removed automatically by XF when the addon is uninstalled.
    }
}
