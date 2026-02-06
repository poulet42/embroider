import { dirname, resolve } from 'path';
import type { ModuleRequest, ResolverFunction, Resolution } from '@embroider/core';
import { Resolver as EmbroiderResolver, ResolverOptions as EmbroiderResolverOptions } from '@embroider/core';
import type { Compiler } from '@rspack/core';
import assertNever from 'assert-never';
import makeDebug from 'debug';
import escapeRegExp from 'escape-string-regexp';

const debug = makeDebug('embroider:rspack-resolver');

export { EmbroiderResolverOptions as Options };

const virtualLoaderName = '@embroider/rspack/src/virtual-loader';
const virtualLoaderPath = resolve(__dirname, './virtual-loader.js');

export class EmbroiderPlugin {
  #resolver: EmbroiderResolver;
  #babelLoaderPrefix: string;
  #appRoot: string;
  // Track context -> virtual module filename mappings
  // This helps us fix missing issuers for imports from virtual modules
  #virtualModuleContexts: Map<string, string> = new Map();

  constructor(opts: EmbroiderResolverOptions, babelLoaderPrefix: string) {
    this.#resolver = new EmbroiderResolver(opts);
    this.#babelLoaderPrefix = babelLoaderPrefix;
    this.#appRoot = opts.appRoot;
  }

  #addLoaderAlias(compiler: Compiler, name: string, alias: string) {
    let { resolveLoader } = compiler.options;
    if (Array.isArray(resolveLoader.alias)) {
      resolveLoader.alias.push({ name, alias });
    } else if (resolveLoader.alias) {
      resolveLoader.alias[name] = alias;
    } else {
      resolveLoader.alias = {
        [name]: alias,
      };
    }
  }

  apply(compiler: Compiler) {
    this.#addLoaderAlias(compiler, virtualLoaderName, virtualLoaderPath);

    // Rspack supports the same normalModuleFactory hook as webpack
    compiler.hooks.normalModuleFactory.tap('@embroider/rspack', normalModuleFactory => {
      // Create a fallback resolver that uses rspack's actual resolver
      let adaptedResolve = getAdaptedResolve(normalModuleFactory, this.#virtualModuleContexts);

      normalModuleFactory.hooks.resolve.tapAsync(
        { name: '@embroider/rspack', stage: 50 },
        (state: unknown, callback) => {
          let request = RspackModuleRequest.from(
            state,
            this.#babelLoaderPrefix,
            this.#appRoot,
            this.#virtualModuleContexts
          );
          if (!request) {
            debug('No embroider request, passing through');
            callback();
            return;
          }

          debug('Resolving %s from %s', request.specifier, request.fromFile);

          this.#resolver.resolve(request, adaptedResolve).then(
            resolution => {
              switch (resolution.type) {
                case 'not_found':
                  debug('Embroider could not resolve %s, letting rspack try', request.specifier);
                  // Don't pass the error - just let the normal resolution chain continue
                  callback();
                  break;
                case 'found':
                  // Rspack's resolve hook returns void; the state is modified in place
                  debug('Resolution succeeded for %s', request.specifier);
                  callback(null);
                  break;
                default:
                  throw assertNever(resolution);
              }
            },
            err => {
              debug('Resolution error for %s: %O', request.specifier, err);
              callback(err);
            }
          );
        }
      );
    });
  }
}

// This creates a fallback resolver for @embroider/core's resolver.
// We use rspack's enhanced-resolve to actually try to resolve modules.
// The fallback resolver receives the request state that may have been modified
// by the Embroider resolver (e.g., virtualized with loaders), and it needs to
// resolve that potentially modified request.
function getAdaptedResolve(
  normalModuleFactory: any,
  virtualModuleContexts: Map<string, string>
): ResolverFunction<RspackModuleRequest, Resolution<null, null | Error>> {
  return function (request: RspackModuleRequest): Promise<Resolution<null, null | Error>> {
    return new Promise((resolve) => {
      const context = dirname(request.fromFile);
      // Use the current state.request, which may have been modified by Embroider (e.g., virtualized)
      const requestToResolve = request.state.request;

      debug('Fallback resolver attempting to resolve %s from %s', requestToResolve, context);

      // If the request contains loader syntax (contains '!'), it's a loader request
      // and we should just accept it as-is, letting rspack's module loading handle it
      if (requestToResolve.includes('!')) {
        debug('Fallback resolver detected loader request, accepting as-is');

        // Track virtual modules by extracting the 'f' parameter from virtual-loader requests
        if (requestToResolve.includes(virtualLoaderName)) {
          // Extract query string specifically from virtual-loader part
          // Format: ...!@embroider/rspack/src/virtual-loader?f=...&a=...!
          const virtualLoaderMatch = requestToResolve.match(new RegExp(escapeRegExp(virtualLoaderName) + '\\?([^!]+)'));
          if (virtualLoaderMatch) {
            try {
              const params = new URLSearchParams(virtualLoaderMatch[1]);
              const filename = params.get('f');
              if (filename) {
                virtualModuleContexts.set(dirname(filename), filename);
                debug('Tracked virtual module from fallback: context=%s, filename=%s', dirname(filename), filename);
              }
            } catch (e) {
              debug('Failed to extract virtual module filename from %s', requestToResolve);
            }
          }
        }

        resolve({
          type: 'found',
          result: null
        });
        return;
      }

      // For normal module requests, use rspack's resolver
      const resolver = normalModuleFactory.getResolver('normal');
      resolver.resolve({}, context, requestToResolve, {}, (err: Error | null, result: string | false | undefined) => {
        if (err || !result) {
          // If we got a PackagePathNotExported error, try manual resolution
          if (err && err.message && err.message.includes('PackagePathNotExported')) {
            debug('Fallback resolver got PackagePathNotExported for %s, trying manual resolution', requestToResolve);

            // Check if this is a root package import (e.g., "@repo/qonto-mirage") or subpath (e.g., "@repo/qonto-mirage/utils/foo")
            const subpathMatch = requestToResolve.match(/^(@?[^/]+\/[^/]+)\/(.+)$/);
            const rootMatch = requestToResolve.match(/^(@?[^/]+\/[^/]+)$/);

            if (subpathMatch) {
              // Subpath import like "@repo/qonto-mirage/utils/product-offers"
              const [, packageName, subpath] = subpathMatch;
              const fs = require('fs');
              const path = require('path');

              // Manually construct package directory path
              const candidatePackageDirs = [
                path.join(context, 'node_modules', packageName),
                path.join(context, '..', 'node_modules', packageName),
                path.join(context, '..', '..', 'node_modules', packageName),
              ];

              for (const packageDir of candidatePackageDirs) {
                if (!fs.existsSync(packageDir)) {
                  continue;
                }

                // Try src/subpath.js (common pattern for ESM packages)
                const candidatePaths = [
                  path.join(packageDir, 'src', subpath + '.js'),
                  path.join(packageDir, 'src', subpath + '.ts'),
                  path.join(packageDir, 'src', subpath, 'index.js'),
                  path.join(packageDir, 'src', subpath, 'index.ts'),
                  path.join(packageDir, subpath + '.js'),
                  path.join(packageDir, subpath + '.ts'),
                  path.join(packageDir, subpath, 'index.js'),
                  path.join(packageDir, subpath, 'index.ts'),
                ];

                for (const candidatePath of candidatePaths) {
                  if (fs.existsSync(candidatePath)) {
                    debug('Fallback resolver manually resolved %s to %s', requestToResolve, candidatePath);
                    // Update the request state to point to the resolved file
                    request.state.request = candidatePath;
                    resolve({
                      type: 'found',
                      result: null
                    });
                    return;
                  }
                }

                debug('Fallback resolver found package dir %s but no matching file for subpath %s', packageDir, subpath);
              }

              debug('Fallback resolver could not find package directory for %s', requestToResolve);
              resolve({
                type: 'not_found',
                err: err || new Error(`Module not found: ${requestToResolve}`)
              });
              return;
            } else if (rootMatch) {
              // Root package import like "@repo/qonto-mirage"
              const [, packageName] = rootMatch;
              const fs = require('fs');
              const path = require('path');
              debug('Fallback resolver handling root package import for %s', packageName);

              // Manually construct package directory path
              const candidatePackageDirs = [
                path.join(context, 'node_modules', packageName),
                path.join(context, '..', 'node_modules', packageName),
                path.join(context, '..', '..', 'node_modules', packageName),
              ];

              for (const packageDir of candidatePackageDirs) {
                if (!fs.existsSync(packageDir)) {
                  continue;
                }

                // Try to find the main entry point
                const packageJsonPath = path.join(packageDir, 'package.json');
                if (fs.existsSync(packageJsonPath)) {
                  try {
                    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

                    // Try different entry point fields
                    const entryPoints = [
                      packageJson.module,
                      packageJson.main,
                      'src/index.js',
                      'src/index.ts',
                      'index.js',
                      'index.ts',
                    ].filter(Boolean);

                    for (const entryPoint of entryPoints) {
                      const entryPath = path.resolve(packageDir, entryPoint);
                      if (fs.existsSync(entryPath)) {
                        debug('Fallback resolver manually resolved root package %s to %s', requestToResolve, entryPath);
                        request.state.request = entryPath;
                        resolve({
                          type: 'found',
                          result: null
                        });
                        return;
                      }
                    }

                    debug('Fallback resolver found package.json but no valid entry point for %s', packageName);
                  } catch (e) {
                    debug('Fallback resolver failed to parse package.json for %s: %O', packageName, e);
                  }
                }
              }

              debug('Fallback resolver could not find root package for %s', requestToResolve);
              resolve({
                type: 'not_found',
                err: err || new Error(`Module not found: ${requestToResolve}`)
              });
              return;
            }
          }

          debug('Fallback resolver could not resolve %s: %O', requestToResolve, err);
          resolve({
            type: 'not_found',
            err: err || new Error(`Module not found: ${requestToResolve}`)
          });
        } else {
          debug('Fallback resolver resolved %s to %s', requestToResolve, result);
          resolve({
            type: 'found',
            result: null
          });
        }
      });
    });
  };
}

class RspackModuleRequest implements ModuleRequest {
  readonly specifier: string;
  readonly fromFile: string;
  readonly meta: Record<string, any> | undefined;

  static from(
    state: any,
    babelLoaderPrefix: string,
    appRoot: string,
    virtualModuleContexts: Map<string, string>
  ): RspackModuleRequest | undefined {
    // Basic validation
    if (typeof state.request !== 'string' || typeof state.context !== 'string') {
      debug('Skipping request - invalid state: request=%s, context=%s', typeof state.request, typeof state.context);
      return undefined;
    }

    const issuer = state.contextInfo?.issuer || '';
    debug('Request: %s, Context: %s, Issuer: %s', state.request, state.context, issuer);

    // Track virtual module loads by detecting requests that include the virtual loader
    // This helps us know which virtual module is associated with each context
    if (state.request.includes(virtualLoaderName)) {
      // Extract the 'f' parameter which contains the virtual module filename
      const queryMatch = state.request.match(/\?([^!]+)/);
      if (queryMatch) {
        try {
          const params = new URLSearchParams(queryMatch[1]);
          const filename = params.get('f');
          if (filename) {
            virtualModuleContexts.set(dirname(filename), filename);
            debug('Tracked virtual module: context=%s, filename=%s', dirname(filename), filename);
          }
        } catch (e) {
          debug('Failed to extract virtual module filename from %s', state.request);
        }
      }
      // Let this request pass through - we don't want to handle the virtual loader request itself
      debug('Skipping virtual loader request');
      return undefined;
    }

    // Prevent recursion on loader requests
    if (state.request.startsWith('!')) {
      debug('Skipping loader request');
      return undefined;
    }

    // Fix missing issuers for imports from virtual modules
    // Rspack doesn't set the issuer correctly for imports from virtual modules
    if (!state.contextInfo?.issuer || state.contextInfo.issuer === '') {
      debug('Empty issuer detected for request: %s', state.request);

      // For requests for implicit modules files, use a known working virtual module as issuer
      // This gives Embroider a valid resolution context
      if (state.request.includes('-embroider-implicit-')) {
        // Try to find ANY tracked virtual module to use as issuer
        // Prefer the main app's implicit modules file if available
        let fallbackIssuer: string | undefined;
        for (let [_ctx, filename] of virtualModuleContexts.entries()) {
          if (filename.includes('rewritten-app') && filename.includes('-embroider-implicit-modules.js')) {
            fallbackIssuer = filename;
            break;
          }
        }
        // If we don't have a tracked module yet, use a heuristic based on context
        if (!fallbackIssuer && state.context.includes('rewritten-app')) {
          fallbackIssuer = state.context + '/-embroider-implicit-modules.js';
        }

        if (fallbackIssuer) {
          if (!state.contextInfo) {
            state.contextInfo = { issuer: '' };
          }
          state.contextInfo.issuer = fallbackIssuer;
          debug('Using fallback issuer %s for implicit modules request %s', fallbackIssuer, state.request);
        } else {
          debug('No fallback issuer available for implicit modules request %s', state.request);
        }
      } else {
        // Check if this is an import from a known virtual module context
        const virtualModule = virtualModuleContexts.get(state.context);
        if (virtualModule) {
          // This is a regular import FROM a virtual module, use the tracked issuer
          debug('Found virtual module for context %s: %s', state.context, virtualModule);
          if (!state.contextInfo) {
            state.contextInfo = { issuer: '' };
          }
          state.contextInfo.issuer = virtualModule;
          debug('Fixed empty issuer to %s for request %s', virtualModule, state.request);
        } else {
          // Not a virtual module import - let rspack handle it
          debug('No virtual module found, letting rspack handle request: %s', state.request);
          return undefined;
        }
      }
    }

    // Only proceed if we have a valid issuer (either original or fixed)
    // OR if this is an implicit modules request (which can have empty issuer)
    const hasValidIssuer = typeof state.contextInfo?.issuer === 'string' && state.contextInfo.issuer !== '';
    const isImplicitModulesRequest = state.request.includes('-embroider-implicit-');

    if (
      typeof state.request === 'string' &&
      typeof state.context === 'string' &&
      (hasValidIssuer || isImplicitModulesRequest)
    ) {
      const issuerDisplay = state.contextInfo?.issuer || '(empty for implicit modules)';
      debug('Creating RspackModuleRequest for %s from %s', state.request, issuerDisplay);
      return new RspackModuleRequest(babelLoaderPrefix, appRoot, state);
    }

    // Fallback: let rspack handle it
    debug('Fallback: letting rspack handle request %s', state.request);
    return undefined;
  }

  constructor(
    private babelLoaderPrefix: string,
    private appRoot: string,
    public state: {
      request: string;
      context: string;
      contextInfo: {
        issuer: string;
        _embroiderMeta?: Record<string, any> | undefined;
      };
    },
    public isVirtual = false
  ) {
    // these get copied here because we mutate the underlying state as we
    // convert one request into the next, and it seems better for debuggability
    // if the fields on the previous request don't change when you make a new
    // one (although it is true that only the newest one has a a valid `state`
    // that can actually be handed back to rspack)
    this.specifier = state.request;
    this.fromFile = state.contextInfo.issuer;
    this.meta = state.contextInfo._embroiderMeta ? { ...state.contextInfo._embroiderMeta } : undefined;
  }

  alias(newSpecifier: string) {
    this.state.request = newSpecifier;
    return new RspackModuleRequest(this.babelLoaderPrefix, this.appRoot, this.state) as this;
  }
  rehome(newFromFile: string) {
    if (this.fromFile === newFromFile) {
      return this;
    } else {
      this.state.contextInfo.issuer = newFromFile;
      this.state.context = dirname(newFromFile);
      return new RspackModuleRequest(this.babelLoaderPrefix, this.appRoot, this.state) as this;
    }
  }
  virtualize(filename: string) {
    let params = new URLSearchParams();
    params.set('f', filename);
    params.set('a', this.appRoot);
    let next = this.alias(`${this.babelLoaderPrefix}${virtualLoaderName}?${params.toString()}!`);
    next.isVirtual = true;
    return next;
  }
  withMeta(meta: Record<string, any> | undefined): this {
    this.state.contextInfo._embroiderMeta = meta;
    return new RspackModuleRequest(this.babelLoaderPrefix, this.appRoot, this.state) as this;
  }
}
