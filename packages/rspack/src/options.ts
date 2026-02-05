import type { Configuration } from '@rspack/core';

// [babel-loader](https://webpack.js.org/loaders/babel-loader/#options) specific options.
// This does not include the babel configuration, which is pulled from the app, only the
// additional options that `babel-loader` supports.
export interface BabelLoaderOptions {
  cacheDirectory?: boolean | string;
  cacheIdentifier?: string;
  cacheCompression?: boolean;
  customize?: string;
}

export interface Options {
  // This allows you to extend the rspack config in arbitrary ways. Your
  // changes will get applied on top of the defaults provided by
  // @embroider/rspack.
  //
  // Note: Rspack's configuration API is highly compatible with webpack's,
  // so this property is named `webpackConfig` for backward compatibility.
  webpackConfig: Configuration;

  // the base public URL for your assets in production. Use this when you want
  // to serve all your assets from a different origin (like a CDN) than your
  // actual index.html will be served on.
  //
  // This should be a URL ending in "/".
  //
  // For example:
  //
  // 1. If your build produces the file "./dist/assets/chunk.123.js"
  // 2. And you set publicAssetURL to "https://cdn/"
  // 3. Browsers will try to locate the file at
  //    "https://cdn/assets/chunk.123.js".
  //
  // Notice that `publicAssetURL` gets applied relative to your whole built
  // application -- not a particular subdirectory like "/assets". If you don't
  // want a part of the path to show up in the public URLs, you should adjust the
  // actual locations of the output files to remove that directory. For example:
  //
  // webpackConfig: {
  //   output: {
  //     // This overrides our default of "assets/chunk.[chunkhash].js"
  //     // to move the chunks to the root of the app, eliminating the assets subdirectory.
  //     filename: `mychunk.[chunkhash].js`,
  //     chunkFilename: `mychunk.[chunkhash].js`,
  //   },
  // },
  // publicAssetURL: "https://cdn/",
  //
  // The above example will result in CDN URLs like "https://cdn/mychunk.123.js".
  //
  publicAssetURL?: string;

  babelLoaderOptions?: BabelLoaderOptions;

  /**
   * Options for [`css-loader`](https://webpack.js.org/loaders/css-loader)
   */
  cssLoaderOptions?: object;

  /**
   * Options for Rspack's built-in [`CssExtractRspackPlugin`](https://rspack.rs/plugins/rspack/css-extract-rspack-plugin)
   */
  cssPluginOptions?: object;

  /**
   * Options for [`style-loader`](https://webpack.js.org/loaders/style-loader/).
   *
   * Note that Rspack's built-in [`CssExtractRspackPlugin`](https://rspack.rs/plugins/rspack/css-extract-rspack-plugin)
   * is used instead of `style-loader` in production builds.
   */
  styleLoaderOptions?: object;
}
