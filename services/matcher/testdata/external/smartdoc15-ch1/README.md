# SmartDoc 2015 - Challenge 1 Dataset - `models.tar.gz` archive
Easy to download and parse version of the Smartdoc 2015 - Challenge 1 dataset.

The original version of this dataset can be obtained at http://smartdoc.univ-lr.fr/.

## About SmartDoc 2015 - Challenge 1
The Smartdoc 2015 - Challenge 1 dataset was originally created for the Smartdoc 2015 competition focusing on the evaluation of document image acquisition method using smartphones. The challenge 1, in particular, consisted in detecting and segmenting document regions in video frames extracted from the preview stream of a smartphone. 

The following video shows the ideal segmentation output (in red outline) for the preview phase of some acquisition session.
[![Video of ideal segmentation of a document page during capture preview.](https://img.youtube.com/vi/WNsI0R_rpO0/0.jpg)](https://www.youtube.com/watch?v=WNsI0R_rpO0)

To build our dataset, we took six different document types coming from public databases and we chose five document images per class. We have chosen the different types so that they cover different document layout schemes and contents (either completely textual or having a high graphical content).

Each of these document models was printed using a color laser-jet on A4 format normal paper and we proceeded to capture them using a Google Nexus 7 tablet. We recorded small video clips of around 10 seconds for each of the 30 documents in 5 different background scenarios. The videos were recorded using Full HD 1920x1080 resolution at variable frame-rate. Since we captured the videos by hand-holding and moving the tablet, the video frames present realistic distortions such as focus and motion blur, perspective, change of illumination and even partial occlusions of the document pages. Summarizing, up to now, the database consists of 150 video clips comprising around 24.000 frames.

We ground-truthed this collection by annotating the quadrilateral coordinates of the document position for each frame in the collection.

The associated dataset, like this new version, are licensed under a Creative Commons Attribution 4.0 International License <http://creativecommons.org/licenses/by/4.0/>.

Original author attribution should be given by citing the following conference paper: Jean-Christophe Burie, Joseph Chazalon, Mickaël Coustaty, Sébastien Eskenazi, Muhammad Muzzamil Luqman, Maroua Mehri, Nibal Nayef, Jean-Marc OGIER, Sophea Prum and Marçal Rusinol: “ICDAR2015 Competition on Smartphone Document Capture and OCR (SmartDoc)”, In 13th International Conference on Document Analysis and Recognition (ICDAR), 2015.

## About this new version
This new version contains the same images and the same ground truth, but in a format which makes training and testing algorithms easier. We also tried to better identify the tasks researchers can test their methods against using this dataset. Regarding the format, video files were converted to series of images, and ground truth files were converted to a CSV file. Image for the models were also added.

A Python wrapper to facilitate data loading is also available at https://github.com/jchazalon/smartdoc15-ch1-pywrapper.
**If you use Python, we recommend you check the wrapper's documentation directly to use this dataset.**


## Content of this archive

### Files hierarchy

    models.tar.gz
    ├── README.md
    ├── LICENCE
    ├── VERSION
    ├── correct_perspective.m
    ├── original_datasets_files.txt
    ├── metadata.csv.gz
    ├── 01-original
    │   ├── datasheet001.png
    │   ├── [...]
    │   └── tax005.png
    ├── 02-edited
    │   ├── datasheet001.png
    │   ├── [...]
    │   └── tax005.png
    ├── 03-captured-nexus
    │   ├── datasheet001.jpg # JPG images here
    │   ├── [...]
    │   └── tax005.jpg
    ├── 04-corrected-nexus
    │   ├── datasheet001.png
    │   ├── [...]
    │   └── tax005.png
    └── 05-corrected-nexus-scaled33
        ├── datasheet001.png
        ├── [...]
        └── tax005.png

### Files description
 - `README.md`: current file
 - `LICENCE`: description of the usage terms
 - `VERSION`: current version of the dataset
 - `correct_perspective.m`: script used to correct the perspective of the "03-captured-nexus" images
 - `original_datasets_files.txt`: file name of the document model in their original datasets
 - `metadata.csv.gz`: image metadata file (see below)
 - `01-original/`: Original images extracted from the datasets described in `original_datasets_files.txt`.
 - `02-edited/`: Edited images so they fit an A4 page and all have the same shape.
 - `03-captured-nexus/`: Images captured using a Google Nexus 7 tablet, trying the keep the document  part as rectangular as possible.
 - `04-corrected-nexus/`: Image with perspective roughly corrected by manually selecting the four corners  and warping the image to the quadrilateral of the edited image using the Matlab script `correct_perspective.m`.
 - `05-corrected-nexus-scaled33/`: Corrected images scaled to roughly fit the size under which documents will be  viewed in a full HD (1080 x 1920) preview frame captured in a regular smartphone.

There are 30 images in each folder, one for each document model:
 - datasheet: datasheet001, datasheet002, datasheet003, datasheet004, datasheet005
 - letter: letter001, letter002, letter003, letter004, letter005
 - magazine: magazine001, magazine002, magazine003, magazine004, magazine005
 - paper: paper001, paper002, paper003, paper004, paper005
 - patent: patent001, patent002, patent003, patent004, patent005
 - tax: tax001, tax002, tax003, tax004, tax005

**Warning**
 - The images in `01-original/` do not have the same shape, but the images of the other directories do.
 - The images in `03-captured-nexus` are JPEG images (with a `.jpg`) extension, but the other are PNGs.
 - We recommend using the `05-corrected-nexus-scaled33` if you want to use local descriptors to match the
   document models with their representation in the frames.

### Metadata file `metadata.csv.gz`
The metadata file is a CSV file (separator: `,`, string quoting: None).
It is safe to split on `,` tokens as they do not appear elsewhere in this file.
Each row describes a model image.
Columns are:
 - `model_cat`: Model category (example: `05-corrected-nexus-scaled33`). There are
   5 categories:
   - `01-original`: Original images extracted from the datasets described in `original_datasets_files.txt`.
   - `02-edited`: Edited images so they fit an A4 page and all have the same shape.
   - `03-captured-nexus`: Images captured using a Google Nexus 7 tablet, trying the keep the document
     part as rectangular as possible.
   - `04-corrected-nexus`: Image with perspective roughly corrected by manually selecting the four corners
     and warping the image to the quadrilateral of the edited image using the Matlab script `correct_perspective.m`.
   - `05-corrected-nexus-scaled33`: Corrected images scaled to roughly fit the size under which documents will be
     viewed in a full HD (1080 x 1920) preview frame captured in a regular smartphone.
 - `model_name`: Name of the document (example: `datasheet001`). There are 30 documents, 5 instances of each document
   class (see below for the list of document classes). Documents are named from `001` to `005`.
 - `model_id`: Model id (example: `0`), 0-indexed. Value is between 0 and 29.
 - `modeltype_name`: Document class (example: `datasheet`). There are 6 document classes:
   - `datasheet`
   - `letter`
   - `magazine`
   - `paper`
   - `patent`
   - `tax`
 - `modeltype_id`: Model type id (example: `0`), 0-indexed. Value is between 0 and 5.
 - `model_subid`: Document sub-index (example: `1`).
 - `image_path`: Relative path to the model image (example: `05-corrected-nexus-scaled33/datasheet001.png`)
   under the dataset home directory.

Example of header + a random line:

    model_cat,model_name,model_id,modeltype_name,modeltype_id,model_subid,image_path
    02-edited,paper005,19,paper,3,4,02-edited/paper005.png
