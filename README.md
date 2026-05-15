# Paint by numbers generator
Generate paint by number images (vectorized with SVG) from any input image.

> **Modernized fork (v2).** The original was a 2019 proof of concept. This fork
> brings it up to date: a modern, secure dependency stack (**0 npm
> vulnerabilities**, down from 60), an [esbuild](https://esbuild.github.io/)
> build replacing requirejs/AMD, ESLint (replacing the deprecated TSLint),
> TypeScript 5, jQuery 3.7, Node 20+ support, and a CI pipeline that
> type-checks, lints, builds and smoke-tests the CLI. The image-processing
> algorithm itself is unchanged. A latent bug where the **Lab** clustering
> color space was unreachable has also been fixed.

## Demo

Try it out [here](https://drake7707.github.io/paintbynumbersgenerator/index.html)

### CLI Version

The CLI version is a self contained node application that does the conversion from arguments, for example:
```
node dist/cli.js -i input.png -o output.svg
```
You can change the settings in settings.json or optionally specify a specific settings.json with the `-c path_to_settings.json` argument.

The settings contain mostly the same settings in the web version:
 - randomSeed: the random seed to choose the initial starting points of the k-means clustering algorithm. This ensures that the same results are generated each time.
 - kMeansNrOfClusters: the number of colors to quantize the image to
 - kMeansMinDeltaDifference: the threshold delta distance of the k-means clustering to reach before stopping. Having a bigger value will speed up the clustering but may yield suboptimal clusters. Default 1
 - kMeansClusteringColorSpace: the color space to apply clustering in
 - kMeansColorRestrictions: Specify which colors should be used. An array of rgb values (as number array) or names of colors (reference to color aliases). If no colors are specified no restrictions are applied. Useful if you only have a few colors of paint on hand.
 - colorAliases: map of key/values where the keys are the color names and the values are the rgb colors (as number array). You can use the color names in the color restrictions above. The names are also mentioned in the output json that tells you how much % of the area is of that specific color.
       ```
       "colorAliases": {
              "A1": [            0,            0,            0        ],
              "A2": [            255,            0,            0        ],
              "A3": [            0,            255,            0        ],
          }
        ```
 - removeFacetsSmallerThanNrOfPoints: removes any facets that are smaller than the given amount of pixels. Lowering the value will create more detailed results but might be much harder to actually paint due to their size.
 - removeFacetsFromLargeToSmall (true/false): largest to smallest will prevent boundaries from warping the shapes because the smaller facets act as border anchorpoints but can be considerably slower
 - maximumNumberOfFacets: if there are more facets than the given maximum number, keep removing the smallest facets until the limit is reached
 
 - nrOfTimesToHalveBorderSegments: reducing the amount of points in a border segment (using haar wavelet reduction) will smooth out the quadratic curve more but at a loss of detail. A segment (shared border with a facet) will always retain its start and end point.
 
 - narrowPixelStripCleanupRuns: narrow pixel cleanup removes strips of single pixel rows, which would make some facets have some borders segments that are way too narrow to be useful. The small facet removal can introduce new narrow pixel strips, so this is repeated in a few iterative runs.
 
 - resizeImageIfTooLarge (true/false): if true and the input image is larger than the given dimensions then it will be resized to fit but will maintain its ratio.
 - resizeImageWidth: width restriction
 - resizeImageHeight: height restriction

There are also output profiles that you can define to output the result to svg, png, jpg with specific settings, for example:
```
  "outputProfiles": [
        {
            "name": "full",
            "svgShowLabels": true,
            "svgFillFacets": true,
            "svgShowBorders": true,
            "svgSizeMultiplier": 3,
            "svgFontSize": 50,
            "svgFontColor": "#333",
            "filetype": "png"
        },
        {
            "name": "bordersLabels",
            "svgShowLabels": true,
            "svgFillFacets": false,
            "svgShowBorders": true,
            "svgSizeMultiplier": 3,
            "svgFontSize": 50,
            "svgFontColor": "#333",
            "filetype": "svg"
        },
        {
            "name": "jpgtest",
            "svgShowLabels": false,
            "svgFillFacets": true,
            "svgShowBorders": false,
            "svgSizeMultiplier": 3,
            "svgFontSize": 50,
            "svgFontColor": "#333",
            "filetype": "jpg",
            "filetypeQuality": 80
        }
    ]
```
This defines 3 output profiles. The "full" profile shows labels, fills the facets and shows the borders with a 3x size multiplier, font size weight of 50, color of #333 and output to a png image. The bordersLabels profile outputs to a svg file without filling facets and jpgtest outputs to a jpg file with jpg quality setting  of 80.

The CLI version also outputs a json file that gives more information about the palette, which colors are used and in what quantity, e.g.:
```
  ...
  {
    "areaPercentage": 0.20327615489130435,
    "color": [ 59, 36, 27 ],
    "frequency": 119689,
    "index": 0
  },
   ...
```

The CLI version is useful if you want to automate the process into your own scripts.

## Screenshots

![Screenshot](https://i.imgur.com/6uHm78x.png])

![Screenshot](https://i.imgur.com/cY9ieAy.png)


## Example output

![ExampleOutput](https://i.imgur.com/2Zuo13d.png)

![ExampleOutput2](https://i.imgur.com/SxWhOc7.png)

## Running locally

Requires **Node.js 20+** (see `.nvmrc`).

```
npm install      # restore packages
npm start        # build the web app and serve it at http://127.0.0.1:10001/
npm run dev      # same, but rebuilds on source changes
```

### Available scripts

| Script              | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `npm start`         | Build the web app and serve it locally                   |
| `npm run dev`       | Serve with rebuild-on-change (watch mode)                |
| `npm run build`     | Build both the web bundle and the CLI                    |
| `npm run build:web` | Bundle the browser app to `scripts/main.js`              |
| `npm run build:cli` | Bundle the CLI to `dist/cli.js`                          |
| `npm run typecheck` | Type-check with `tsc --noEmit`                           |
| `npm run lint`      | Lint with ESLint                                         |
| `npm run check`     | Type-check + lint + build (run before committing)        |

## Building the CLI version

`pkg` is no longer used (it is unmaintained and never bundled the native
`canvas`/`sharp` binaries cleanly). Instead, build the bundled CLI with:

```
npm run build:cli
node dist/cli.js -i input.png -o output.svg -c src-cli/settings.json
```

`dist/cli.js` is a self-contained Node script (the native `canvas` and `sharp`
modules are resolved from `node_modules` at runtime). The `paint-by-numbers-generator`
bin entry points at it, so `npm install -g .` also works.
