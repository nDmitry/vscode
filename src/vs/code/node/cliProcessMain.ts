/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import product from 'vs/platform/product';
import pkg from 'vs/platform/package';
import * as path from 'path';
import { ParsedArgs } from 'vs/platform/environment/node/argv';
import { TPromise } from 'vs/base/common/winjs.base';
import { sequence } from 'vs/base/common/async';
import { IPager } from 'vs/base/common/paging';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { InstantiationService } from 'vs/platform/instantiation/common/instantiationService';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { EnvironmentService } from 'vs/platform/environment/node/environmentService';
import { IEventService } from 'vs/platform/event/common/event';
import { EventService } from 'vs/platform/event/common/eventService';
import { IExtensionManagementService, IExtensionGalleryService, IExtensionManifest, IGalleryExtension } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionManagementService } from 'vs/platform/extensionManagement/node/extensionManagementService';
import { ExtensionGalleryService } from 'vs/platform/extensionManagement/node/extensionGalleryService';
import { ITelemetryService, combinedAppender, NullTelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { TelemetryService, ITelemetryServiceConfig } from 'vs/platform/telemetry/common/telemetryService';
import { resolveCommonProperties } from 'vs/platform/telemetry/node/commonProperties';
import { IRequestService } from 'vs/platform/request/common/request';
import { RequestService } from 'vs/platform/request/node/requestService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ConfigurationService } from 'vs/platform/configuration/node/configurationService';
import { AppInsightsAppender } from 'vs/platform/telemetry/node/appInsightsAppender';
import {mkdirp} from 'vs/base/node/pfs';

const notFound = id => localize('notFound', "Extension '{0}' not found.", id);
const notInstalled = id => localize('notInstalled', "Extension '{0}' is not installed.", id);
const useId = localize('useId', "Make sure you use the full extension ID, including the publisher, eg: {0}", 'ms-vscode.csharp');

function getId(manifest: IExtensionManifest): string {
	return `${ manifest.publisher }.${ manifest.name }`;
}

type Task = { ():TPromise<void> };

class Main {

	constructor(
		@IExtensionManagementService private extensionManagementService: IExtensionManagementService,
		@IExtensionGalleryService private extensionGalleryService: IExtensionGalleryService
	) {}

	run(argv: ParsedArgs): TPromise<any> {
		// TODO@joao - make this contributable

		if (argv['list-extensions']) {
			return this.listExtensions();
		} else if (argv['install-extension']) {
			const arg = argv['install-extension'];
			const ids: string[] = typeof arg === 'string' ? [arg] : arg;
			return this.installExtension(ids);
		} else if (argv['uninstall-extension']) {
			const arg = argv['uninstall-extension'];
			const ids: string[] = typeof arg === 'string' ? [arg] : arg;
			return this.uninstallExtension(ids);
		}
	}

	private listExtensions(): TPromise<any> {
		return this.extensionManagementService.getInstalled().then(extensions => {
			extensions.forEach(e => console.log(getId(e.manifest)));
		});
	}

	private installExtension(extensions: string[]): TPromise<any> {
		const vsixTasks: Task[] = extensions
			.filter(e => /\.vsix$/i.test(e))
			.map(id => () => {
				const extension = path.isAbsolute(id) ? id : path.join(process.cwd(), id);

				return this.extensionManagementService.install(extension).then(() => {
					console.log(localize('successVsixInstall', "Extension '{0}' was successfully installed!", path.basename(extension)));
				});
			});

		const galleryTasks: Task[] = extensions
			.filter(e => !/\.vsix$/i.test(e))
			.map(id => () => {
				return this.extensionManagementService.getInstalled().then(installed => {
					const isInstalled = installed.some(e => getId(e.manifest) === id);

					if (isInstalled) {
						console.log(localize('alreadyInstalled', "Extension '{0}' is already installed.", id));
						return TPromise.as(null);
					}

					return this.extensionGalleryService.query({ names: [id] })
						.then<IPager<IGalleryExtension>>(null, err => {
							if (err.responseText) {
								try {
									const response = JSON.parse(err.responseText);
									return TPromise.wrapError(response.message);
								} catch (e) {
									return TPromise.wrapError(err);
								}
							}
						})
						.then(result => {
							const [extension] = result.firstPage;

							if (!extension) {
								return TPromise.wrapError(`${ notFound(id) }\n${ useId }`);
							}

							console.log(localize('foundExtension', "Found '{0}' in the marketplace.", id));
							console.log(localize('installing', "Installing..."));

							return this.extensionManagementService.installFromGallery(extension)
								.then(() => console.log(localize('successInstall', "Extension '{0}' v{1} was successfully installed!", id, extension.version)));
						});
				});
			});

		return sequence([...vsixTasks, ...galleryTasks]);
	}

	private uninstallExtension(ids: string[]): TPromise<any> {
		return sequence(ids.map(id => () => {
			return this.extensionManagementService.getInstalled().then(installed => {
				const [extension] = installed.filter(e => getId(e.manifest) === id);

				if (!extension) {
					return TPromise.wrapError(`${ notInstalled(id) }\n${ useId }`);
				}

				console.log(localize('uninstalling', "Uninstalling {0}...", id));

				return this.extensionManagementService.uninstall(extension)
					.then(() => console.log(localize('successUninstall', "Extension '{0}' was successfully uninstalled!", id)));
			});
		}));
	}
}

const eventPrefix = 'monacoworkbench';

export function main(argv: ParsedArgs): TPromise<void> {
	const services = new ServiceCollection();
	services.set(IEnvironmentService, new SyncDescriptor(EnvironmentService, argv, process.execPath));

	const instantiationService: IInstantiationService = new InstantiationService(services);

	return instantiationService.invokeFunction(accessor => {
		const envService = accessor.get(IEnvironmentService);

		return TPromise.join([envService.appSettingsHome, envService.userHome, envService.extensionsPath].map(p => mkdirp(p))).then(() => {
			const { appRoot, extensionsPath, extensionDevelopmentPath, isBuilt } = envService;

			const services = new ServiceCollection();
			services.set(IEventService, new SyncDescriptor(EventService));
			services.set(IConfigurationService, new SyncDescriptor(ConfigurationService));
			services.set(IRequestService, new SyncDescriptor(RequestService));
			services.set(IExtensionManagementService, new SyncDescriptor(ExtensionManagementService));
			services.set(IExtensionGalleryService, new SyncDescriptor(ExtensionGalleryService));

			if (isBuilt && !extensionDevelopmentPath && product.enableTelemetry) {
				const appenders: AppInsightsAppender[] = [];

				if (product.aiConfig && product.aiConfig.key) {
					appenders.push(new AppInsightsAppender(eventPrefix, null, product.aiConfig.key));
				}

				if (product.aiConfig && product.aiConfig.asimovKey) {
					appenders.push(new AppInsightsAppender(eventPrefix, null, product.aiConfig.asimovKey));
				}

				// It is important to dispose the AI adapter properly because
				// only then they flush remaining data.
				process.once('exit', () => appenders.forEach(a => a.dispose()));

				const config: ITelemetryServiceConfig = {
					appender: combinedAppender(...appenders),
					commonProperties: resolveCommonProperties(product.commit, pkg.version),
					piiPaths: [appRoot, extensionsPath]
				};

				services.set(ITelemetryService, new SyncDescriptor(TelemetryService, config));
			} else {
				services.set(ITelemetryService, NullTelemetryService);
			}

			const instantiationService2 = instantiationService.createChild(services);
			const main = instantiationService2.createInstance(Main);

			return main.run(argv);
		});
	});
}
