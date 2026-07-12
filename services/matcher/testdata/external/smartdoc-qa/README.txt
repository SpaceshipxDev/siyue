SmartDoc-QA dataset
https://sites.google.com/site/smartdocqa/home

For using this dataset please cite the following paper:
N. Nayef et al. "SmartDoc-QA: A Dataset for Quality Assessment of Smartphone Captured Document Images - Single and Multiple Distortions". CBDAR, 2015

Contact: nibal.nayef@univ-lr.fr


Presentation
=============================
The quality assessment step is an important part of both the acquisition and the digitization processes. Assessing document quality could aid users during the capture process or help improve image enhancement methods after a document has been captured. Current state-of-the-art works lack databases in the field of document image quality assessment. 
In order to provide a baseline benchmark for quality assessment methods for mobile captured documents, we present a database for quality assessment that contains both single- and multiply-distorted document images.
The proposed dataset could be used for benchmarking quality assessment methods by the objective measure of OCR accuracy, and could be also used to benchmark quality enhancement methods. There are three types of documents in the dataset: modern documents, old administrative letters and receipts.
The document images of the dataset are captured under varying capture conditions (light, different types of blur and perspective angles). This causes geometric and photometric distortions that hinder the OCR process.
The ground truth of the dataset images consists of the text transcriptions of the documents, the OCR results of the captured documents and the values of the different capture parameters used for each image.


Documents
=============================

In order to cover different contexts of application and make our proposed dataset useful in real world commercial applications, we use the following three different categories of paper documents to create our dataset:

	Category~1: 10 contemporary documents (selected from the SmartDoc competition documents)
	Category~2: 10 old administrative documents (selected from the Tobacco dataset)
	Category~3: 10 real receipts from various shops


Folder structure and contents
=============================
The contents of SmartDoc-QA dataset contains 2 main folders:

Ground_truth/
	*Text transcriptions for the original documents (manually keyed)*
	+-- 1.txt
	+-- 2.txt
	+-- 3.txt
	...
	
Captured_Images/
	Samsung_Phone/
		*captured images of all documents using Samsung Galaxy S4. Format of file name is explained in the following paragraph*
		Images/
			+-- S_Img_Android_D1_L1_r35_a0_b0.jpg
			+-- S_Img_Android_D1_L1_r35_a0_b0_Mb1.jpg
			+-- S_Img_Android_D1_L1_r35_a0_b0_Ob1.jpg
			+-- M_Img_Android_D1_L2_r35_a-10_b5.jpg
			+-- M_Img_Android_D1_L2_r35_a-10_b5_Mb2.jpg
			+-- M_Img_Android_D1_L2_r35_a-10_b5_Ob2.jpg
			...
		Results_Finereader/
			+-- S_Img_Android_D1_L1_r35_a0_b0.txt
			+-- S_Img_Android_D1_L1_r35_a0_b0_Mb1.txt
			+-- S_Img_Android_D1_L1_r35_a0_b0_Ob1.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5_Mb2.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5_Ob2.txt
			...
		Results_Tesseract/
			+-- S_Img_Android_D1_L1_r35_a0_b0.txt
			+-- S_Img_Android_D1_L1_r35_a0_b0_Mb1.txt
			+-- S_Img_Android_D1_L1_r35_a0_b0_Ob1.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5_Mb2.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5_Ob2.txt
			...
		OCR_Accuracy_Finereader/
			+-- S_Img_Android_D1_L1_r35_a0_b0.cacc.txt
			+-- S_Img_Android_D1_L1_r35_a0_b0.wacc.txt
			+-- S_Img_Android_D1_L1_r35_a0_b0_Mb1.cacc.txt
			+-- S_Img_Android_D1_L1_r35_a0_b0_Mb1.wacc.txt
			+-- S_Img_Android_D1_L1_r35_a0_b0_Ob1.cacc.txt
			+-- S_Img_Android_D1_L1_r35_a0_b0_Ob1.wacc.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5.cacc.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5.wacc.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5_Mb2.cacc.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5_Mb2.wacc.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5_Ob2.cacc.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5_Ob2.wacc.txt
			...
		OCR_Accuracy_Tesseract/
			+-- S_Img_Android_D1_L1_r35_a0_b0.cacc.txt
			+-- S_Img_Android_D1_L1_r35_a0_b0.wacc.txt
			+-- S_Img_Android_D1_L1_r35_a0_b0_Mb1.cacc.txt
			+-- S_Img_Android_D1_L1_r35_a0_b0_Mb1.wacc.txt
			+-- S_Img_Android_D1_L1_r35_a0_b0_Ob1.cacc.txt
			+-- S_Img_Android_D1_L1_r35_a0_b0_Ob1.wacc.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5.cacc.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5.wacc.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5_Mb2.cacc.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5_Mb2.wacc.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5_Ob2.cacc.txt
			+-- M_Img_Android_D1_L2_r35_a-10_b5_Ob2.wacc.txt
			...
	Nokia_Phone/
		*captured images of all documents using Nokia Lumia 920*
		*It has the same structure as Samsung_Galaxy_S4 folder*
		*For file names, replace "Android" by "WP"
		Images/
			+-- S_Img_WP_D1_L1_r35_a0_b0.jpg
		...
		...


Format of file name
=============================
Meaning of the letters that compose file names in the «Images» folder (and hence, the corresponding OCR-related folders):

- S: Single distortion
- M: Multiple distortions
- D: Document number. This number corresponds to file name of document in folder «Ground_truth»
- L: Light condition.
	- L1: day light only (without any artificial lights)
	- L2: day light + ceiling neon light
	- L3: night + table lamp light
	- L4: table lamp light + an object casting shadow on a part of the document
	- L5: table lamp light + an object casting a grid shadow on the document
- r: distance from camera objective to document (35cm)
- a: Longitudinal incidence angle (mobile rotation around Y-axis): 2 values around the parallel position with a discrete step of 5 degrees (-10, -5, 0, 5)
- b: Lateral incidence angle (mobile rotation around X-axis): 2 values around the parallel position with a discrete step of 5 degrees (-5, 0, 5, 10)
- Mb: Motion blur
	- Mb1: horizontal motion
	- Mb2: 2D motion
- Ob: out-of-focus blur
	*For Samsung phone, for "S_Img"*
	- Ob1: focus point is at 22.5cm and capture is at 35cm (for parallel position) or 34.34cm (for the other four positions)
	- Ob2: focus point is at 21.5cm and capture is at 35cm (for parallel position) or 34.34cm (for the other four positions)
	- Ob3: focus point is at 20.5cm and capture is at 35cm (for parallel position) or 34.34cm (for the other four positions)
	- Ob4: focus point is at 19.5cm and capture is at 35cm (for parallel position) or 34.34cm (for the other four positions)

	*For Samsung phone, for "M_Img"*
	- Ob1: for parallel position: focus point is at 21.66cm and capture is at 35cm,  for the other four positions: focus point is at 21.0cm and capture is at 34.4cm
	- Ob2: for parallel position: focus point is at 19.66cm and capture is at 35cm,  for the other four positions: focus point is at 19.0cm and capture is at 34.4cm

	*For Nokia phone: for all images: the number after "Ob" refers to some parameter that allows to change the focus distance, from experiments, with the distance 35cm which we
	use for capture, the images are focused when the value is between 850 and 900, hence above or below those values, the images have out-of-focus blur*
	- Ob820
	- Ob830
	- Ob840
	- Ob940
	- The two values: Ob910 and Ob930 have been additionally used for Document number 1
*************************************************************************************************************************************************************************************************************
